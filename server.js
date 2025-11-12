// server.js — BetEstimate v5.5.5 (ESPN parser with enhanced error handling and logging)
import express from 'express';
import dotenv from 'dotenv';
import cron from 'node-cron';
import * as cheerio from 'cheerio';

dotenv.config();
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TZ = process.env.TZ || 'Europe/Istanbul';

const ENABLE_ESPN = process.env.ENABLE_ESPN !== '0';
const ESPN_SCHEDULE_URL = (process.env.ESPN_SCHEDULE_URL || 'https://www.espn.com/soccer/schedule').replace(/\/+$/, '');
const ESPN_DEBUG = process.env.ESPN_DEBUG === '1';
const ADSENSE_ACCOUNT = process.env.ADSENSE_ACCOUNT || 'ca-pub-4391382697370741';
const ADSENSE_SLOT_TOP = process.env.ADSENSE_SLOT_TOP || '';
const ADSENSE_SLOT_MID = process.env.ADSENSE_SLOT_MID || '';
const ADSENSE_SLOT_FOOT = process.env.ADSENSE_SLOT_FOOT || '';
const ESPN_LOOSE = process.env.ESPN_LOOSE === '1';

const START_HOUR = parseInt(process.env.START_HOUR || '0', 10);
const END_HOUR = 24;
const HIDE_PREDICTIONLESS = (process.env.HIDE_PREDICTIONLESS ?? '1') === '1';

const SHARPEN_TAU_1X2 = parseFloat(process.env.SHARPEN_TAU_1X2 || '1.25');
const STRONG_DIFF_TILT = parseFloat(process.env.STRONG_DIFF_TILT || '220');
const EDGE_MIN = parseFloat(process.env.EDGE_MIN || '0.08');

// Enhanced logging configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Custom logger
const logger = {
  info: (msg, ...args) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...args),
  debug: (msg, ...args) => ESPN_DEBUG && console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...args)
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

// Add security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Utility functions
function fmtYMD(d, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}

function todayYMD(tz = TZ) { 
  return fmtYMD(new Date(), tz); 
}

function addDaysLocalYMD(days = 0, tz = TZ) {
  const now = new Date();
  const base = new Date(now.getTime() + days * 24 * 3600 * 1000);
  return fmtYMD(base, tz);
}

function localParts(iso, tz = TZ) {
  const dt = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dt);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute };
}

function toLocalLabel(iso, tz = TZ) {
  const { y, m, d, hh, mm } = localParts(iso, tz);
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}`;
}

// --- Basic strengths (seeded)
function normTeam(s = '') { 
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); 
}

const ALIAS = new Map([
  ['paris saint germain', 'psg'], ['paris saint germain fc', 'psg'],
  ['manchester city fc', 'manchester city'], ['manchester united fc', 'manchester united'],
  ['fc barcelona', 'barcelona'], ['fc bayern munich', 'bayern munich'],
  ['fc internazionale milano', 'inter'], ['fc internazionale', 'inter'],
  ['juventus fc', 'juventus'], ['ac milan', 'milan'],
  ['atletico de madrid', 'atletico madrid'], ['ssc napoli', 'napoli'],
  ['as roma', 'roma'], ['tottenham hotspur', 'tottenham'],
  ['fenerbahce istanbul', 'fenerbahce'], ['galatasaray sk', 'galatasaray'], ['besiktas jk', 'besiktas'],
  ['arsenal fc', 'arsenal'], ['chelsea fc', 'chelsea'], ['liverpool fc', 'liverpool'],
  ['real madrid cf', 'real madrid'], ['borussia dortmund', 'dortmund'],
  ['atletico madrid', 'atletico madrid'], ['sevilla fc', 'sevilla'], ['valencia cf', 'valencia'],
  ['rcd mallorca', 'mallorca'], ['athletic bilbao', 'athletic bilbao'], ['real betis', 'betis'],
  ['rsc anderlecht', 'anderlecht'], ['olympique lyonnais', 'lyon'], ['olympique marseille', 'marseille'],
  ['as monaco', 'monaco'], ['lille osc', 'lille'], ['ajax amsterdam', 'ajax'], ['psv eindhoven', 'psv'],
  ['fc porto', 'porto'], ['sporting lisbon', 'sporting cp'], ['sl benfica', 'benfica'],
]);

function canonicalKey(name) { 
  const n = normTeam(name); 
  return ALIAS.get(n) || n; 
}

const SEED_ELO = {
  'psg': 1850, 'paris saint germain': 1850, 'real madrid': 1850, 'barcelona': 1820,
  'manchester city': 1880, 'liverpool': 1820, 'arsenal': 1800, 'chelsea': 1750,
  'manchester united': 1760, 'bayern munich': 1900, 'inter': 1820, 'juventus': 1800,
  'milan': 1780, 'atletico madrid': 1800, 'napoli': 1780, 'roma': 1740, 'tottenham': 1760,
  'galatasaray': 1700, 'fenerbahce': 1680, 'besiktas': 1650, 'trabzonspor': 1620,
  'dortmund': 1780, 'sevilla': 1720, 'valencia': 1700, 'betis': 1720, 'lyon': 1720,
  'marseille': 1730, 'monaco': 1740, 'lille': 1710, 'ajax': 1750, 'psv': 1740,
  'porto': 1760, 'benfica': 1770, 'sporting cp': 1750
};

function seedOf(name) { 
  const k = canonicalKey(name); 
  return SEED_ELO[k] ?? SEED_ELO[normTeam(name)] ?? 1500; 
}

function leagueBaseGpm(league = '') { 
  const k = (league || '').toLowerCase(); 
  if (k.includes('super lig') || k.includes('süper lig')) return 2.7; 
  if (k.includes('premier')) return 2.9; 
  if (k.includes('la liga')) return 2.6; 
  if (k.includes('bundesliga')) return 3.1; 
  if (k.includes('serie a')) return 2.5; 
  if (k.includes('ligue 1')) return 2.75; 
  if (k.includes('eredivisie')) return 3.0; 
  if (k.includes('primeira')) return 2.5; 
  if (k.includes('champions league')) return 3.0; 
  if (k.includes('europa league')) return 2.8; 
  if (k.includes('conference league')) return 2.7; 
  return 2.65; 
}

// ---- Model (Poisson)
function fac(n) { 
  let r = 1; 
  for (let i = 2; i <= n; i++) r *= i; 
  return r; 
}

function poisPmf(l, k) { 
  return Math.exp(-l) * Math.pow(l, k) / fac(k); 
}

function probs1X2(lh, la, cap = 12) { 
  let pH = 0, pD = 0, pA = 0; 
  for (let i = 0; i <= cap; i++) { 
    const ph = poisPmf(lh, i); 
    for (let j = 0; j <= cap; j++) { 
      const pa = poisPmf(la, j); 
      if (i > j) pH += ph * pa; 
      else if (i === j) pD += ph * pa; 
      else pA += ph * pa; 
    } 
  } 
  const s = pH + pD + pA || 1; 
  return { pH: pH / s, pD: pD / s, pA: pA / s }; 
}

function sharpen3(pH, pD, pA, tau) { 
  const a = Math.pow(pH, tau), b = Math.pow(pD, tau), c = Math.pow(pA, tau); 
  const Z = (a + b + c) || 1; 
  return { pH: a / Z, pD: b / Z, pA: c / Z }; 
}

function expectedGoalsAdvanced(homeName, awayName, league) { 
  const base = leagueBaseGpm(league); 
  const HOME = 65; 
  const rh = seedOf(homeName), ra = seedOf(awayName); 
  const diff = (rh + HOME) - ra; 
  let split = 0.5 + 0.12 * Math.tanh(diff / 650); 
  split = Math.max(0.36, Math.min(0.64, split)); 
  let lh = base * split * (1 + diff / 2200); 
  let la = base * (1 - split) * (1 - diff / 2200); 
  if (seedOf(homeName) - seedOf(awayName) >= STRONG_DIFF_TILT) { 
    lh *= 1.10; 
    la *= 0.90; 
  } 
  lh = Math.max(0.15, Math.min(3.2, lh)); 
  la = Math.max(0.15, Math.min(3.2, la)); 
  return { lh, la }; 
}

function choiceFrom(lh, la) { 
  let { pH, pD, pA } = probs1X2(lh, la); 
  ({ pH, pD, pA } = sharpen3(pH, pD, pA, SHARPEN_TAU_1X2)); 
  const best1 = [{ label: '1', p: pH }, { label: 'X', p: pD }, { label: '2', p: pA }].sort((a, b) => b.p - a.p)[0]; 
  const edge1 = best1.p - 1 / 3; 
  const tot = lh + la; 
  const pU25 = (function (l) { let s = 0; for (let i = 0; i <= 2; i++) s += poisPmf(l, i); return s; })(tot); 
  const pO25 = 1 - pU25; 
  const bestTot = pO25 >= pU25 ? { market: 'Over/Under 2.5', label: 'Over 2.5', p: pO25 } : { market: 'Over/Under 2.5', label: 'Under 2.5', p: pU25 }; 
  const edgeTot = bestTot.p - 0.5; 
  const pBTTS = 1 - (Math.exp(-lh) + Math.exp(-la) - Math.exp(-(lh + la))); 
  const bestBTTS = pBTTS >= 0.5 ? { market: 'BTTS', label: 'Yes', p: pBTTS } : { market: 'BTTS', label: 'No', p: 1 - pBTTS }; 
  const edgeBTTS = bestBTTS.p - 0.5; 
  const cand = [
    { market: '1X2', label: best1.label, prob: best1.p, edge: edge1, base: 0.33 },
    { market: bestTot.market, label: bestTot.label, prob: bestTot.p, edge: edgeTot, base: 0.50 },
    { market: 'BTTS', label: bestBTTS.label, prob: bestBTTS.p, edge: edgeBTTS, base: 0.50 }
  ].sort((a, b) => b.edge - a.edge); 
  const top = cand[0], second = cand[1]; 
  if (top.edge < EDGE_MIN) top.note = 'low-edge-fallback'; 
  return { top, second }; 
}

// ---- HTTP helpers
const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0'
};

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000); // Increased timeout
  try {
    const res = await fetch(url, { headers: H, signal: ctrl.signal });
    const status = res.status;
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    return { status, json, txt };
  } catch (error) {
    logger.error(`Failed to fetch ${url}: ${error.message}`);
    throw error;
  } finally { 
    clearTimeout(t); 
  }
}

// ---- ESPN parsing helpers
function headerMap($, $table) {
  const heads = [];
  $table.find('thead th').each((i, th) => heads.push($(th).text().trim().toUpperCase()));
  const idx = { match: -1, time: -1 };
  heads.forEach((h, i) => {
    if (h.includes('MATCH') || h.includes('MATCHUP')) idx.match = i;
    if (h.includes('TIME') || h.includes('DATE')) idx.time = i;
  });
  return idx;
}

// Improved league detection for ESPN
function nearestLeague($, node) {
  let el = $(node);

  // Look for league name in various possible locations
  for (let i = 0; i < 6; i++) {
    // Check previous siblings for header elements
    const prevHeader = el.prevAll('h1, h2, h3, h4, h5, .Table__Title, .card-header, .header').first();
    if (prevHeader.length) {
      const text = prevHeader.text().trim();
      if (text && !text.includes('Date') && !text.includes('Schedule')) {
        return text;
      }
    }

    // Check parent elements for data attributes or classes that might contain league info
    const parent = el.parent();
    const parentClass = parent.attr('class') || '';
    const parentId = parent.attr('id') || '';

    if (parentClass.includes('league') || parentId.includes('league')) {
      const text = parent.text().trim();
      if (text) return text.split('\n')[0].trim();
    }

    // Check for aria-label or data attributes
    const ariaLabel = el.attr('aria-label') || parent.attr('aria-label');
    if (ariaLabel && !ariaLabel.includes('Date')) {
      return ariaLabel;
    }

    el = parent;
    if (!el.length) break;
  }

  // Fallback: try to find any text above the table that looks like a league name
  const tableContainer = $(node).closest('div, section');
  const aboveText = tableContainer.prevAll('h1, h2, h3, h4, h5, div').first().text().trim();
  if (aboveText && aboveText.length < 100 && !aboveText.includes('Date')) {
    return aboveText;
  }

  return 'Unknown Competition';
}

function looksOddsNoise(s) {
  return /^line:/i.test(s) ||
    /^o\/u/i.test(s) ||
    /espnbet/i.test(s) ||
    /odds:/i.test(s) ||
    /money line/i.test(s) ||
    /^pick:/i.test(s) ||
    (s.length < 3 && !/[A-Z]{2,}/.test(s)); // Only filter very short non-team text
}

// More flexible league filtering - include more competitions
function isWantedLeague(leagueName) {
  if (!leagueName || leagueName === 'Unknown Competition') {
    return ESPN_LOOSE; // Allow unknown competitions if ESPN_LOOSE is enabled
  }

  const league = leagueName.toLowerCase();

  // Major leagues to INCLUDE (expanded list)
  const wantedPatterns = [
    // Top European leagues
    'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
    // European competitions
    'champions league', 'europa league', 'conference league',
    // Other major leagues
    'super lig', 'süper lig', 'eredivisie', 'primeira liga', 'premiership',
    // English lower divisions
    'championship', 'league one', 'league two', 'efl',
    // Spanish lower divisions
    'la liga 2', 'segunda division',
    // Other European leagues
    'belgian', 'austrian', 'swiss', 'russian', 'ukrainian', 'scottish',
    // South American
    'copa libertadores', 'copa sudamericana', 'brasileirão', 'serie b', 'argentina',
    // African leagues
    'premier league', 'kenya', 'nigeria', 'south africa', 'egypt',
    // Cups
    'fa cup', 'efl cup', 'copa del rey', 'dfb pokal', 'coppa italia',
    // MLS and others
    'mls', 'major league soccer'
  ];

  // Patterns to EXCLUDE (youth, women, friendlies)
  const excludePatterns = [
    'u17', 'u18', 'u19', 'u20', 'u21', 'u23', 'women', 'friendly',
    'youth', 'academy', 'reserve', 'development', 'women\'s', 'girls'
  ];

  // Check if league matches any exclusion patterns
  for (const pattern of excludePatterns) {
    if (league.includes(pattern)) {
      return false;
    }
  }

  // Check if league matches any wanted patterns
  for (const pattern of wantedPatterns) {
    if (league.includes(pattern)) {
      return true;
    }
  }

  // If ESPN_LOOSE is enabled, include unknown leagues
  return ESPN_LOOSE;
}

// Helper function to clean individual team names
function cleanTeamName(team) {
  if (!team) return '';

  return team
    .replace(/\s*\(\w+\)$/, '') // Remove country codes (A) etc.
    .replace(/^(FC|AFC|CF|CD|SD|UD)\s+/i, '') // Remove common prefixes
    .replace(/\s+(FC|CF|CD|SD|UD)$/i, '') // Remove common suffixes
    .replace(/\s*\d+:\d+\s*$/, '') // Remove trailing scores
    .trim();
}

// Improved team name cleaning for ESPN - handles various formats
function cleanTeams(text) {
  if (!text) return { home: '', away: '' };

  let t = text.replace(/\s+/g, ' ').trim();

  // Remove common betting lines and noise
  if (looksOddsNoise(t)) return { home: '', away: '' };

  logger.debug('Parsing match text:', t);

  // Try multiple separator patterns in order of preference
  const separators = [
    /\s+vs\.?\s+/i,        // " vs " or " vs. " (most common)
    /\s+v\s+/i,            // " v " 
    /\s+@\s+/i,            // " @ "
    /\s+[-–—]\s+/,         // " - ", en-dash, em-dash
    /\s+at\s+/i,           // " at "
  ];

  for (const separator of separators) {
    const parts = t.split(separator);
    if (parts.length === 2) {
      let home = parts[0].trim();
      let away = parts[1].trim();

      // Clean up team names
      home = cleanTeamName(home);
      away = cleanTeamName(away);

      // Basic validation
      if (home.length >= 2 && away.length >= 2 && home !== away) {
        logger.debug('Successfully parsed with separator:', { home, away, separator: separator.toString() });
        return { home, away };
      }
    }
  }

  // Fallback: try common patterns without explicit separators
  const patterns = [
    // Pattern for "TeamA TeamB" format (common in ESPN)
    /^([A-Za-z][A-Za-z\s]+?)\s+([A-Z][A-Za-z\s]+)$/,
    // Pattern for teams with FC/United/City etc.
    /^([A-Za-z\s]+?(?:FC|United|City|Town|FC))\s+([A-Za-z\s]+?(?:FC|United|City|Town|FC))$/i,
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      let home = cleanTeamName(match[1]);
      let away = cleanTeamName(match[2]);

      if (home.length >= 2 && away.length >= 2 && home !== away) {
        logger.debug('Successfully parsed with pattern:', { home, away, pattern: pattern.toString() });
        return { home, away };
      }
    }
  }

  // Last resort: manual mapping for known problematic teams
  const manualMap = {
    'AFC Toronto': { home: 'Toronto', away: '' }, // This might be a single team listing
    'Burgos': { home: 'Burgos', away: '' }, // Same issue
    'Cheltenham Town': { home: 'Cheltenham Town', away: '' },
    // Add more as needed
  };

  if (manualMap[t]) {
    logger.debug('Using manual mapping for:', t);
    return manualMap[t];
  }

  logger.debug('Failed to parse teams:', t);
  return { home: '', away: '' };
}

// Improved time parsing for ESPN
function parseEspnTime(timeText, tz = TZ) {
  if (!timeText || !/\d/.test(timeText)) return todayYMD(tz);

  const today = new Date();
  const timeMatch = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);

  if (!timeMatch) return todayYMD(tz);

  let hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  const period = timeMatch[3]?.toUpperCase();

  // Convert to 24-hour format
  if (period === 'PM' && hours < 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;

  // Create date in target timezone
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return `${dateStr} ${timeStr}`;
}

// ---- ESPN source (MATCH/TIME table aware) with predictions
async function sourceEspnScheduleToday(tz = TZ) {
  if (!ENABLE_ESPN) return { rows: [], meta: { name: 'espn', used: false } };
  
  const ymd = todayYMD(tz).replace(/-/g, '');
  const url = `${ESPN_SCHEDULE_URL}/_/date/${ymd}`;
  let html = '';
  
  try {
    logger.info(`Fetching ESPN schedule from: ${url}`);
    const res = await fetch(url, {
      redirect: 'follow',
      headers: H,
      timeout: 15000
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    html = await res.text();
    logger.info(`Successfully fetched ESPN data, length: ${html.length}`);
  } catch (err) {
    logger.error(`Failed to fetch ESPN schedule: ${err.message}`);
    return { 
      rows: [], 
      meta: { 
        name: 'espn', 
        used: true, 
        error: 'fetch_failed', 
        url, 
        message: err.message 
      } 
    };
  }

  const $ = cheerio.load(html);
  const tables = $('table');
  const out = [];
  let unknown = 0;
  let successfulParses = 0;
  let filteredLeagues = 0;

  logger.debug(`Found ${tables.length} tables on ESPN page`);

  tables.each((_, tbl) => {
    const $tbl = $(tbl);
    const idx = headerMap($, $tbl);
    if (idx.match === -1 || idx.time === -1) {
      logger.debug('Skipping table - not a MATCH/TIME table');
      return; // not a MATCH/TIME table
    }

    const leagueRaw = nearestLeague($, $tbl) || '';
    const league = leagueRaw || 'Unknown Competition';

    // Filter out unwanted leagues (youth, women, friendlies)
    if (!isWantedLeague(league)) {
      logger.debug('Filtered out league:', league);
      filteredLeagues++;
      return;
    }

    logger.debug('Processing league:', league);

    $tbl.find('tbody tr').each((__, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      
      const matchText = $(tds[idx.match]).text().replace(/\s+/g, ' ').trim();
      const timeText = $(tds[idx.time]).text().replace(/\s+/g, ' ').trim();

      if (!matchText || looksOddsNoise(matchText)) {
        if (matchText) logger.debug('Skipping noise:', matchText);
        return;
      }

      const { home, away } = cleanTeams(matchText);
      if (!home || !away) {
        logger.debug('Failed to parse teams:', matchText);
        return;
      }

      logger.debug('Successfully parsed:', { league, original: matchText, home, away });
      successfulParses++;

      if (/^unknown/i.test(league)) unknown++;

      const kickoff = parseEspnTime(timeText, tz);

      // Generate predictions for all ESPN matches
      const { lh, la } = expectedGoalsAdvanced(home, away, league);
      const ch = choiceFrom(lh, la);

      let primary = '', alt = '';
      let primaryEdgePct = 0, altEdgePct = 0;

      if (ch?.top) {
        primary = `${ch.top.market}: ${ch.top.label} (${Math.round(ch.top.prob * 100)}%)`;
        primaryEdgePct = Math.round(Math.max(0, ch.top.edge) * 100);
      }
      if (ch?.second) {
        alt = `${ch.second.market}: ${ch.second.label} (${Math.round(ch.second.prob * 100)}%)`;
        altEdgePct = Math.round(Math.max(0, ch.second.edge) * 100);
      }

      out.push({
        league,
        kickoff,
        home,
        away,
        prediction: primary,
        altPrediction: alt,
        primaryEdgePct,
        altEdgePct,
        source: 'ESPN'
      });
    });
  });

  // de-dupe
  const uniq = new Map();
  for (const r of out) {
    const key = `${r.league}__${r.home}__${r.away}__${r.kickoff}`;
    if (!uniq.has(key)) uniq.set(key, r);
  }
  
  const rows = Array.from(uniq.values()).sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''));

  logger.info(`ESPN parsing complete: ${rows.length} matches found, ${successfulParses} successful parses, ${filteredLeagues} leagues filtered`);

  if (ESPN_DEBUG && rows.length > 0) {
    logger.debug('Sample predictions:', rows.slice(0, 3).map(r => ({
      league: r.league,
      home: r.home,
      away: r.away,
      prediction: r.prediction,
      edge: r.primaryEdgePct
    })));
  }

  return {
    rows,
    meta: {
      name: 'espn',
      used: true,
      count: rows.length,
      successfulParses,
      filteredLeagues,
      url,
      unknown
    }
  };
}

// ---- Fetch & merge (ESPN only now)
async function fetchFixturesToday() {
  const date = todayYMD();
  let rows = [];

  try {
    const espn = await sourceEspnScheduleToday(TZ);
    rows = espn.rows || [];
    logger.info(`ESPN returned ${rows.length} matches for today`);
  } catch (e) {
    logger.error('ESPN error in fetchFixturesToday:', e);
  }

  // time window filter
  rows = rows.filter(r => {
    const m = (r.kickoff || '').match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!m) return true;
    const hh = parseInt(m[2], 10);
    return (hh >= START_HOUR && hh < END_HOUR);
  });

  if (HIDE_PREDICTIONLESS) rows = rows.filter(r => r.prediction);

  return { date, rows, count: rows.length };
}

// ---- Cache & schedule
let CACHE = { date: null, rows: [], savedAt: null, error: null };

async function warmCache() {
  try {
    logger.info('Starting cache refresh from ESPN...');
    const fresh = await fetchFixturesToday();
    CACHE = {
      ...fresh,
      savedAt: new Date().toISOString(),
      source: 'ESPN-only',
      error: null
    };
    logger.info(`Cache refresh complete: ${fresh.rows.length} rows from ESPN`);
  } catch (e) {
    const errorMsg = String(e?.message || e);
    logger.error('Cache warm error:', errorMsg);
    CACHE = {
      date: todayYMD(),
      rows: [],
      savedAt: new Date().toISOString(),
      error: errorMsg
    };
  }
}

// Schedule cache warming
cron.schedule('1 0 * * *', async () => {
  await warmCache();
}, { timezone: TZ });

// Additional cache warming every 6 hours for freshness
cron.schedule('0 */6 * * *', async () => {
  logger.info('Scheduled 6-hour cache refresh');
  await warmCache();
}, { timezone: TZ });

// ---- Debug endpoint to see raw ESPN data
app.get('/debug-espn-raw', async (_req, res) => {
  const ymd = todayYMD(TZ).replace(/-/g, '');
  const url = `${ESPN_SCHEDULE_URL}/_/date/${ymd}`;

  try {
    const response = await fetch(url, { headers: H });
    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract sample table data for debugging
    const tables = $('table');
    const tableData = [];

    tables.each((i, table) => {
      const $table = $(table);
      const league = nearestLeague($, table);
      const rows = [];

      $table.find('tbody tr').each((j, row) => {
        const cells = [];
        $(row).find('td').each((k, cell) => {
          cells.push($(cell).text().trim());
        });
        rows.push(cells);
      });

      tableData.push({
        tableIndex: i,
        league,
        header: $table.find('thead th').map((i, th) => $(th).text().trim()).get(),
        sampleRows: rows.slice(0, 3) // First 3 rows
      });
    });

    res.json({
      url,
      tablesFound: tables.length,
      tableData,
      cacheInfo: {
        date: CACHE.date,
        savedAt: CACHE.savedAt,
        count: CACHE.rows?.length || 0
      }
    });
  } catch (error) {
    logger.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: {
      date: CACHE.date,
      count: CACHE.rows?.length || 0,
      savedAt: CACHE.savedAt,
      error: CACHE.error
    },
    memory: {
      used: process.memoryUsage().heapUsed / 1024 / 1024,
      total: process.memoryUsage().heapTotal / 1024 / 1024
    }
  });
});

// ---- UI
const HEAD = `
  <meta charset="utf-8" />
  <meta name="google-adsense-account" content="${ADSENSE_ACCOUNT}">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_ACCOUNT}" crossorigin="anonymous"></script>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BetEstimate.com — Today's AI Football Predictions</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .ad-wrap{background:transparent; border:1px dashed rgba(148,163,184,.25); border-radius:.75rem; padding:.25rem;}
    .seo-intro{background:rgba(15,23,42,.5); border:1px solid #1f2937; border-radius:.75rem; padding:10px; font-size:14px;}
    .seo-intro b{color:#93c5fd}
  
    :root{ --bg:#0b1220; --card:#0f172a; --accent:#22d3ee; --accent2:#f59e0b; --good:#bbf7d0; --med:#fde68a; --low:#e5e7eb; --muted:#f3f4f6; }
    body{background:var(--bg); color:#e5e7eb;} a{color:#93c5fd}
    thead.sticky th{position:sticky;top:0;z-index:10}
    tr.edge-strong{ background: rgba(16,185,129,.15); }
    tr.edge-medium{ background: rgba(253,224,71,.12); }
    tr.edge-low{ background: rgba(229,231,235,.06); }
    tr.muted{ background: rgba(229,231,235,.04); color:#9ca3af; }
    .loading{animation:pulse 2s cubic-bezier(0.4,0,0.6,1) infinite;}
    @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.5;}}
  </style>
`;

function headerBar() {
  return `<header class="rounded-xl bg-slate-800/60 border border-slate-700 p-4">
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-3xl md:text-4xl font-extrabold leading-tight">
          BetEstimate<span class="text-cyan-300">.com</span>
        </h1>
        <p class="mt-1 text-sm md:text-base text-slate-300">
          <strong>AI statistical football predictions</strong> for today — 1X2, Over/Under 2.5, BTTS —
          powered by probability models across Premier League, La Liga, Serie A, Bundesliga, Süper Lig and more.
        </p>
      </div>
      <nav class="space-x-3 text-sm"><a href="/">Home</a><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a></nav>
    </div>`;
}

const FOOT = `<footer class="mt-6 text-xs text-slate-300/90 italic">Use the data at your own risk. Informational only — no guarantees. Last updated: <span id="last-updated">-</span></footer>`;

app.get('/api/today', async (_req, res) => {
  const now = todayYMD();
  if (CACHE.date !== now || !CACHE.savedAt) {
    await warmCache();
  }
  res.json(CACHE);
});

app.get('/diag', async (_req, res) => {
  const fresh = await fetchFixturesToday();
  res.json({
    tz: TZ,
    startHour: START_HOUR,
    total: fresh.count,
    sample: fresh.rows.slice(0, 5),
    cache: {
      date: CACHE.date,
      savedAt: CACHE.savedAt,
      count: CACHE.rows?.length || 0
    }
  });
});

app.get('/diag-espn', async (_req, res) => {
  const out = await sourceEspnScheduleToday(TZ);
  res.json({
    url: out.meta?.url,
    count: out.meta?.count || 0,
    successfulParses: out.meta?.successfulParses || 0,
    filteredLeagues: out.meta?.filteredLeagues || 0,
    unknown: out.meta?.unknown || 0,
    sample: (out.rows || []).slice(0, 8)
  });
});

app.get('/', (_req, res) => {
  const html = `<!doctype html><html lang="en"><head>${HEAD}</head><body>
  <div class="max-w-6xl mx-auto p-4 space-y-4">
    ${headerBar()}
    <div class="flex items-center justify-between mb-2">
      <span class="text-sm text-slate-400" id="match-count">Loading matches...</span>
      <button onclick="refreshData()" class="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded transition-colors" id="refresh-btn">
        Refresh
      </button>
    </div>
    <div class="overflow-x-auto bg-slate-900/40 border border-slate-800 rounded-xl shadow">
      <table class="min-w-full text-[13px]" id="tbl">
        <thead class="bg-slate-800 sticky">
          <tr>
            <th class="text-left px-2 py-2">Kickoff</th>
            <th class="text-left px-2 py-2">League</th>
            <th class="text-left px-2 py-2">Home</th>
            <th class="text-left px-2 py-2">Away</th>
            <th class="text-left px-2 py-2">Prediction</th>
            <th class="text-left px-2 py-2">Alt</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    ${FOOT}
  </div>
  <script>
    function rowClass(edge, hasPick){ 
      if(!hasPick) return 'muted'; 
      if(edge>=10) return 'edge-strong'; 
      if(edge>=5) return 'edge-medium'; 
      return 'edge-low'; 
    }
    
    function formatTable(data) {
      const rows = data.rows || [];
      document.getElementById('match-count').textContent = \`\${rows.length} matches found\`;
      document.getElementById('last-updated').textContent = new Date(data.savedAt).toLocaleString();
      
      document.getElementById('rows').innerHTML = rows.map(x => {
        const cls = rowClass(Number(x.primaryEdgePct || 0), !!x.prediction);
        return "<tr class='" + cls + " border-b border-slate-800'>" +
          "<td class='px-2 py-2 whitespace-nowrap'>" + (x.kickoff || '') + "</td>" +
          "<td class='px-2 py-2'>" + (x.league || '') + "</td>" +
          "<td class='px-2 py-2 font-semibold'>" + (x.home || '') + "</td>" +
          "<td class='px-2 py-2'>" + (x.away || '') + "</td>" +
          "<td class='px-2 py-2'>" + (x.prediction || '') + "</td>" +
          "<td class='px-2 py-2 opacity-80'>" + (x.altPrediction || '') + "</td>" +
        "</tr>";
      }).join('');
    }
    
    async function load() {
      try {
        document.getElementById('refresh-btn').classList.add('loading');
        const r = await fetch('/api/today');
        const j = await r.json();
        formatTable(j);
      } catch (error) {
        console.error('Failed to load data:', error);
        document.getElementById('match-count').textContent = 'Error loading matches';
      } finally {
        document.getElementById('refresh-btn').classList.remove('loading');
      }
    }
    
    function refreshData() {
      load();
    }
    
    // Initial load
    load(); 
    // Refresh every 5 minutes
    setInterval(load, 300000);
  </script>
  </body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/about', (_req, res) => {
  const body = `<!doctype html><head>${HEAD}</head><body>
  <div class="max-w-3xl mx-auto p-4">${headerBar()}
  <main class="bg-slate-900/40 border border-slate-800 rounded-xl p-4 mt-4 text-sm space-y-3">
    <p><strong>About BetEstimate</strong></p>
    <p>BetEstimate provides <em>AI statistical football predictions</em> based on probability models, expected goals and recent form indicators. Results are informational only and <strong>use at your own risk</strong>.</p>
    <p>We are committed to Google AdSense policies worldwide and maintain a brand-safe experience for all users.</p>
    <p>Leagues covered include Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Süper Lig and more. Markets include 1X2, Over/Under 2.5 and BTTS.</p>
  </main>${FOOT}</div></body>`;
  res.send(body);
});

app.get('/privacy', (_req, res) => {
  const body = `<!doctype html><head>${HEAD}</head><body>
  <div class="max-w-3xl mx-auto p-4">${headerBar()}
  <main class="bg-slate-900/40 border border-slate-800 rounded-xl p-4 mt-4 text-sm space-y-3">
    <p><strong>Privacy</strong></p>
    <p>We respect your privacy and comply with Google AdSense policies globally. We may use standard analytics and AdSense cookies to deliver and measure ads in accordance with their policies.</p>
    <p>No guarantees are provided on accuracy; predictions are for entertainment and information only. <strong>Use the data at your own risk</strong>.</p>
  </main>${FOOT}</div></body>`;
  res.send(body);
});

app.get('/contact', (_req, res) => {
  res.send('<!doctype html><head>' + HEAD + '</head><body><div class="max-w-3xl mx-auto p-4">' + headerBar() + '<main class="bg-slate-900/40 border border-slate-800 rounded-xl p-4 mt-4 text-sm">contact@betestimate.com</main>' + FOOT + '</div></body>');
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, HOST, () => {
  logger.info(`✅ Server listening on ${HOST}:${PORT}`);
  logger.info(`📅 Using ESPN as data source: ${ESPN_SCHEDULE_URL}`);
  logger.info(`🐛 Debug endpoint available at: /debug-espn-raw`);
  logger.info(`❤️ Health check available at: /health`);
  
  // Initial cache warm with delay
  setTimeout(() => {
    warmCache().catch(e => logger.error('Initial warmCache error', e));
  }, 2000);
});