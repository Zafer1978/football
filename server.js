// server.js — BetEstimate v5.5.3 (ESPN league detection ++, safer fallback)
// - Stronger ESPN league detection: checks nearest headings, ancestor cards, and anchor texts (competition/league links)
// - If league still unknown and ESPN_LOOSE=1, keep row but tag league from any anchor text in row (last resort)
// - If ESPN yields mostly unknown AND HIDE_PREDICTIONLESS=1, API rows will still show (with picks) and dominate
// - Diag logs count detected "unknown" to help tune filters

import express from 'express';
import dotenv from 'dotenv';
import cron from 'node-cron';
import * as cheerio from 'cheerio';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TZ = process.env.TZ || 'Europe/Istanbul';

const API_KEY = process.env.FOOTBALL_DATA_KEY || '';
const ENABLE_ESPN = process.env.ENABLE_ESPN === '1';
const ESPN_SCHEDULE_URL = (process.env.ESPN_SCHEDULE_URL || 'https://www.espn.com/soccer/schedule').replace(/\/+$/,'');
const ESPN_DEBUG = process.env.ESPN_DEBUG === '1';
const ESPN_LOOSE = process.env.ESPN_LOOSE === '1';

const START_HOUR = parseInt(process.env.START_HOUR || '0', 10);
const END_HOUR = 24;

const SHARPEN_TAU_1X2 = parseFloat(process.env.SHARPEN_TAU_1X2 || '1.25');
const STRONG_DIFF_TILT = parseFloat(process.env.STRONG_DIFF_TILT || '220');
const EDGE_MIN = parseFloat(process.env.EDGE_MIN || '0.08');

const HIDE_PREDICTIONLESS = (process.env.HIDE_PREDICTIONLESS ?? '1') === '1';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

function fmtYMD(d, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}
function todayYMD(tz = TZ) { return fmtYMD(new Date(), tz); }
function addDaysLocalYMD(days=0, tz = TZ){
  const now = new Date();
  const base = new Date(now.getTime() + days*24*3600*1000);
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

// ---- League filters
function buildRegex(listStr) {
  const s = (listStr || '').trim();
  if (!s) return null;
  const parts = s.split('|').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}
const RX_PRIMARY   = buildRegex(process.env.ESPN_PRIMARY);
const RX_SECONDARY = buildRegex(process.env.ESPN_SECONDARY);
const RX_INTL      = buildRegex(process.env.ESPN_INTL);
function leagueLooksWanted(leagueLabel = '') {
  const name = (leagueLabel || '').toLowerCase();
  if (!name) return false;
  if (RX_PRIMARY && RX_PRIMARY.test(name)) return true;
  if (RX_SECONDARY && RX_SECONDARY.test(name)) return true;
  if (RX_INTL && RX_INTL.test(name)) return true;
  const defaults = /(premier|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira|super lig|mls|scottish premiership|champions league|europa league|conference league|world cup|qualifier)/i;
  return defaults.test(name);
}

// ---- Team names & seeds
function normTeam(s=''){ return s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
const ALIAS = new Map([
  ['paris saint germain','psg'], ['paris saint germain fc','psg'],
  ['manchester city fc','manchester city'], ['manchester united fc','manchester united'],
  ['fc barcelona','barcelona'], ['fc bayern munich','bayern munich'],
  ['fc internazionale milano','inter'], ['fc internazionale','inter'],
  ['juventus fc','juventus'], ['ac milan','milan'],
  ['atletico de madrid','atletico madrid'], ['ssc napoli','napoli'],
  ['as roma','roma'], ['tottenham hotspur','tottenham'],
  ['fenerbahce istanbul','fenerbahce'], ['galatasaray sk','galatasaray'], ['besiktas jk','besiktas'],
]);
function canonicalKey(name){
  const n = normTeam(name);
  if (ALIAS.has(n)) return ALIAS.get(n);
  return n;
}
const SEED_ELO = {
  'psg':1850,'paris saint germain':1850,'real madrid':1850,'barcelona':1820,
  'manchester city':1880,'liverpool':1820,'arsenal':1800,'chelsea':1750,'manchester united':1760,
  'bayern munich':1900,'inter':1820,'juventus':1800,'milan':1780,'atletico madrid':1800,'napoli':1780,
  'roma':1740,'tottenham':1760,'galatasaray':1700,'fenerbahce':1680,'besiktas':1650,'trabzonspor':1620,
  'nantes':1600
};
function seedOf(name){
  const key = canonicalKey(name);
  return SEED_ELO[key] ?? SEED_ELO[normTeam(name)] ?? 1500;
}
function leagueBaseGpm(league=''){
  const k = (league||'').toLowerCase();
  if (k.includes('super lig') || k.includes('süper lig')) return 2.7;
  if (k.includes('premier')) return 2.9;
  if (k.includes('la liga')) return 2.6;
  if (k.includes('bundesliga')) return 3.1;
  if (k.includes('serie a')) return 2.5;
  if (k.includes('ligue 1')) return 2.75;
  if (k.includes('eredivisie')) return 3.0;
  if (k.includes('primeira')) return 2.5;
  return 2.65;
}

// ---- HTTP
const H = API_KEY ? { 'X-Auth-Token': API_KEY, 'accept': 'application/json' } : {};
async function getJson(url){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: H, signal: ctrl.signal });
    const status = res.status;
    const txt = await res.text();
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    return { status, json, txt };
  } finally { clearTimeout(t); }
}

// ---- Standings + form (best effort)
const standingsCache = new Map();
async function getStandings(compId){
  if (!API_KEY || !compId) return { table: [], map: new Map(), size: 20 };
  if (standingsCache.has(compId)) return standingsCache.get(compId);
  try {
    const { json } = await getJson(`https://api.football-data.org/v4/competitions/${compId}/standings`);
    const total = (json?.standings||[]).find(s => s.type === 'TOTAL');
    const table = total?.table || [];
    const map = new Map();
    for (const row of table) if (row.team?.id) map.set(row.team.id, row.position || 0);
    const pack = { table, map, size: table.length || 20 };
    standingsCache.set(compId, pack);
    return pack;
  } catch { return { table: [], map: new Map(), size: 20 }; }
}

const formCache = new Map();
async function getLastLeagueMatches(teamId, compId){
  if (!API_KEY || !teamId || !compId) return [];
  const key = `${teamId}:${compId}`;
  if (formCache.has(key)) return formCache.get(key);
  const end = new Date();
  const start = new Date(end.getTime() - 60*24*3600*1000);
  const dateFrom = start.toISOString().slice(0,10);
  const dateTo = end.toISOString().slice(0,10);
  try {
    const { json } = await getJson(`https://api.football-data.org/v4/teams/${teamId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`);
    let arr = Array.isArray(json?.matches) ? json.matches : [];
    arr = arr.filter(m => m.competition?.id === compId);
    arr.sort((a,b)=> (b.utcDate||'').localeCompare(a.utcDate||''));
    const last5 = arr.slice(0,5);
    formCache.set(key, last5);
    return last5;
  } catch { return []; }
}

// ---- Model bits (Poisson)
function fac(n){ let r=1; for(let i=2;i<=n;i++) r*=i; return r; }
function poisPmf(lam, k){ return Math.exp(-lam) * Math.pow(lam, k) / fac(k); }
function poisCdf(lam, k){ let s=0; for(let i=0;i<=k;i++) s += poisPmf(lam,i); return s; }
function probs1X2(lh, la, cap=12){
  let pH=0, pD=0, pA=0;
  for(let i=0;i<=cap;i++){
    const ph = poisPmf(lh, i);
    for(let j=0;j<=cap;j++){
      const pa = poisPmf(la, j);
      if (i>j) pH += ph*pa; else if (i===j) pD += ph*pa; else pA += ph*pa;
    }
  }
  const s = pH+pD+pA || 1; return { pH: pH/s, pD: pD/s, pA: pA/s };
}
function sharpen3(pH, pD, pA, tau){
  const a = Math.pow(pH, tau), b = Math.pow(pD, tau), c = Math.pow(pA, tau);
  const Z = (a+b+c) || 1;
  return { pH: a/Z, pD: b/Z, pA: c/Z };
}
function expectedGoalsAdvanced(homeName, awayName, leagueName, homeForm, awayForm){
  const baseG = leagueBaseGpm(leagueName);
  const HOME_ELO = 65;
  const rh = seedOf(homeName);
  const ra = seedOf(awayName);
  const seedDiff = (rh + HOME_ELO) - ra;
  const fToFactor = f => Math.max(0.85, Math.min(1.15, 0.98 + 0.10 * f));
  const homeFormFac = fToFactor(homeForm.formStrength || 0);
  const awayFormFac = fToFactor(awayForm.formStrength || 0);
  let split = 0.5 + 0.12*Math.tanh(seedDiff/650);
  const relForm = (homeFormFac)/(awayFormFac+1e-9);
  split = Math.max(0.36, Math.min(0.64, split * Math.pow(relForm, 0.25)));
  let lh = baseG * split * (1 + seedDiff/2200) * homeFormFac;
  let la = baseG * (1 - split) * (1 - seedDiff/2200) * awayFormFac;
  if (seedOf(homeName) - seedOf(awayName) >= STRONG_DIFF_TILT) { lh *= 1.10; la *= 0.90; }
  lh = Math.max(0.15, Math.min(3.2, lh));
  la = Math.max(0.15, Math.min(3.2, la));
  return { lh, la };
}
function chooseStrongest(lh, la){
  let { pH, pD, pA } = probs1X2(lh, la);
  ({ pH, pD, pA } = sharpen3(pH, pD, pA, SHARPEN_TAU_1X2));
  const best1 = [{label:'1',p:pH},{label:'X',p:pD},{label:'2',p:pA}].sort((a,b)=>b.p-a.p)[0];
  const edge1 = best1.p - 1/3;
  const totLam = lh + la;
  const pU25 = poisCdf(totLam, 2);
  const pO25 = 1 - pU25;
  const bestTot = pO25 >= pU25 ? { market:'Over/Under 2.5', label:'Over 2.5', p:pO25 } : { market:'Over/Under 2.5', label:'Under 2.5', p:pU25 };
  const edgeTot = bestTot.p - 0.5;
  const pBTTS = 1 - (Math.exp(-lh) + Math.exp(-la) - Math.exp(-lh-la));
  const bestBTTS = pBTTS >= 0.5 ? { market:'BTTS', label:'Yes', p:pBTTS } : { market:'BTTS', label:'No', p:1-pBTTS };
  const edgeBTTS = bestBTTS.p - 0.5;
  const candidates = [
    { market:'1X2',               label:best1.label,   prob:best1.p,    edge:edge1,   base:0.33 },
    { market:bestTot.market,      label:bestTot.label, prob:bestTot.p,  edge:edgeTot, base:0.50 },
    { market:bestBTTS.market,     label:bestBTTS.label,prob:bestBTTS.p, edge:edgeBTTS,base:0.50 },
  ].sort((a,b)=> b.edge - a.edge);
  const top = candidates[0];
  const second = candidates[1];
  if (top.edge < EDGE_MIN) top.note = 'low-edge-fallback';
  return { top, second };
}

// ---- Source A: football-data.org
async function sourceFootballDataToday() {
  if (!API_KEY) return { rows: [], meta: { name: 'fd', used: false } };
  const dateFrom = todayYMD(TZ);
  const dateTo = addDaysLocalYMD(1, TZ);
  const url = `https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED,IN_PLAY,PAUSED,FINISHED`;
  const { status, json, txt } = await getJson(url);
  const arr = Array.isArray(json?.matches) ? json.matches : [];

  const rows = [];
  for (const f of arr){
    const league = `${f.competition?.area?.name || ''} ${f.competition?.name || ''}`.trim();
    const compId = f.competition?.id;
    const kickoffIso = f.utcDate;
    const hh = localParts(kickoffIso).hh;
    if (!(hh >= START_HOUR && hh < END_HOUR)) continue;

    const homeName = f.homeTeam?.name || '';
    const awayName = f.awayTeam?.name || '';
    const homeId = f.homeTeam?.id;
    const awayId = f.awayTeam?.id;

    let primary = '', alt = '';
    let primaryEdgePct = 0, altEdgePct = 0;

    try {
      const standingsPack = compId ? await getStandings(compId) : { map:new Map(), size:20 };
      const homeMatches = homeId ? await getLastLeagueMatches(homeId, compId) : [];
      const awayMatches = awayId ? await getLastLeagueMatches(awayId, compId) : [];
      const homeForm = { formStrength: 1.0 };
      const awayForm = { formStrength: 1.0 };
      const eg = expectedGoalsAdvanced(homeName, awayName, league, homeForm, awayForm);
      const choice = chooseStrongest(eg.lh, eg.la);

      if (choice?.top) {
        const p1 = Math.round(choice.top.prob * 100);
        primaryEdgePct = Math.round(Math.max(0, choice.top.edge) * 100);
        primary = `${choice.top.market}: ${choice.top.label} (${p1}%)`;
      }
      if (choice?.second) {
        const p2 = Math.round(choice.second.prob * 100);
        altEdgePct = Math.round(Math.max(0, choice.second.edge) * 100);
        alt = `${choice.second.market}: ${choice.second.label} (${p2}%)`;
      }
    } catch {}

    rows.push({
      league, kickoffIso, kickoff: toLocalLabel(kickoffIso),
      home: homeName, away: awayName,
      prediction: primary, altPrediction: alt,
      primaryEdgePct, altEdgePct, source: 'FD'
    });
  }

  rows.sort((a,b)=> (a.kickoff||'').localeCompare(b.kickoff||''));
  return { rows, meta: { name: 'fd', used: true, count: rows.length, url, status, bodyHead: String(txt).slice(0,300) } };
}

// ---- ESPN helpers
function findLeagueNear($, start){
  const prevHead = $(start).prevAll('h1,h2,h3,h4').first().text().trim();
  if (prevHead) return prevHead;
  let el = $(start);
  for (let i=0;i<5;i++){
    const aria = el.attr('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const cardTitle = el.prevAll('.Card__Header__Title, .Card__Header, .headline').first().text().trim();
    if (cardTitle) return cardTitle;
    el = el.parent();
    if (!el || !el.length) break;
  }
  const aRow = $(start).find('a[href*="competition"], a[href*="league"]').first().text().trim();
  if (aRow) return aRow;
  const aUp = $(start).closest('.Card, section, article').find('a[href*="competition"], a[href*="league"]').first().text().trim();
  if (aUp) return aUp;
  return '';
}

// ---- Source B: ESPN
async function sourceEspnScheduleToday(tz = TZ) {
  if (!ENABLE_ESPN) return { rows: [], meta: { name: 'espn', used: false } };
  const ymd = todayYMD(tz).replace(/-/g, '');
  const url = `${ESPN_SCHEDULE_URL}/_/date/${ymd}`;

  let html = '';
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.8'
      }
    });
    html = await res.text();
  } catch {
    return { rows: [], meta: { name: 'espn', used: true, error: 'fetch_failed', url } };
  }

  if (ESPN_DEBUG) {
    console.log('[ESPN] URL:', url);
    console.log('[ESPN] head:', html.slice(0, 900).replace(/\s+/g,' ').trim());
  }

  const $ = cheerio.load(html);
  const rows = [];
  const blocks = $('table, .Table__TBODY, .ResponsiveTable, .ScheduleTables');
  let unknownCount = 0;

  blocks.each((_, blk) => {
    const leagueGuess = findLeagueNear($, $(blk));
    const league = leagueGuess || 'Unknown Competition';
    const ok = leagueLooksWanted(league);
    if (!(ok || ESPN_LOOSE)) return;

    $(blk).find('tr').each((__, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const c0 = $(tds[0]).text().trim();
      const c1 = $(tds[1]).text().trim();
      const c2 = $(tds[2] || {}).text?.().trim?.() || '';
      const hasTime0 = /\d/.test(c0);
      const hasTime1 = /\d/.test(c1);
      const timeTxt = hasTime0 ? c0 : (hasTime1 ? c1 : '');
      const teams = hasTime0 ? [c1, c2] : [c0, c1];
      let home = (teams[0] || '').replace(/\sv\s*$/i,'').trim();
      let away = (teams[1] || '').replace(/^\sv\s*/i,'').trim();
      if (!home || !away) return;

      let finalLeague = league;
      if (/^unknown/i.test(finalLeague)) {
        const alt = $(tr).find('a[href*="competition"], a[href*="league"]').first().text().trim();
        if (alt) finalLeague = alt;
      }
      if (/^unknown/i.test(finalLeague)) unknownCount++;

      const kickoff = timeTxt ? `${todayYMD(tz)} ${timeTxt}` : todayYMD(tz);
      if (!ESPN_LOOSE && /^unknown/i.test(finalLeague)) return;

      rows.push({ league: finalLeague, kickoff, home, away, prediction:'', altPrediction:'', primaryEdgePct:0, altEdgePct:0, source:'ESPN' });
    });
  });

  const uniq = new Map();
  for (const r of rows) {
    const key = `${r.league}__${r.home}__${r.away}__${r.kickoff}`;
    if (!uniq.has(key)) uniq.set(key, r);
  }
  const finalRows = Array.from(uniq.values()).sort((a,b)=> (a.kickoff||'').localeCompare(b.kickoff||''));

  if (ESPN_DEBUG) console.log('[ESPN] blocks:', blocks.length, 'rows:', finalRows.length, 'unknown:', unknownCount, 'sample:', finalRows.slice(0,5));

  return { rows: finalRows, meta: { name: 'espn', used: true, count: finalRows.length, url, unknown: unknownCount } };
}

// ---- Fetch + merge (ESPN first, then API)
async function fetchFixturesToday() {
  const date = todayYMD();
  let combined = [];

  try {
    const espn = await sourceEspnScheduleToday(TZ);
    combined.push(...(espn.rows||[]));
  } catch(e){ if (ESPN_DEBUG) console.log('[ESPN] error', e); }

  try {
    const fd = await sourceFootballDataToday();
    combined.push(...(fd.rows||[]));
  } catch(e){ console.log('[FD] error', e?.message || e); }

  combined = combined.filter(r => {
    const m = (r.kickoff||'').match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!m) return true;
    const hh = parseInt(m[2],10);
    return (hh >= START_HOUR && hh < END_HOUR);
  });

  const keyOf = r => `${(r.kickoff||'')}__${(r.home||'').toLowerCase()}__${(r.away||'').toLowerCase()}`;
  const pickScore = r => (r.prediction ? 2 : 0) + (r.league && !/^unknown/i.test(r.league) ? 1 : 0) + (r.source==='FD' ? 0.5 : 0);
  const best = new Map();
  for (const r of combined) {
    const k = keyOf(r);
    const cur = best.get(k);
    if (!cur || pickScore(r) > pickScore(cur)) best.set(k, r);
  }
  let rows = Array.from(best.values()).sort((a,b)=> (a.kickoff||'').localeCompare(b.kickoff||''));

  if (HIDE_PREDICTIONLESS) rows = rows.filter(r => r.prediction);

  return { date, rows, count: rows.length };
}

// ---- Cache + schedule
let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  try {
    const fresh = await fetchFixturesToday();
    CACHE = { ...fresh, savedAt: new Date().toISOString() };
    console.log(`[warmCache] ${fresh.rows.length} rows`);
  } catch (e) {
    CACHE = { date: todayYMD(), rows: [], savedAt: new Date().toISOString(), error: String(e?.message || e) };
    console.error('[warmCache] error', e);
  }
}
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

// ---- HEAD & UI
const HEAD_META = `
  <meta charset="utf-8" />
  <meta name="google-adsense-account" content="ca-pub-4391382697370741">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4391382697370741" crossorigin="anonymous"></script>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="BetEstimate.com — AI football predictions & daily fixtures. 1X2, Over/Under 2.5, BTTS — color-coded by confidence." />
  <meta name="keywords" content="BetEstimate, AI football predictions, football tips, match probabilities, over under 2.5, BTTS, sports analytics, daily picks" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root{ --bg:#f1f5f9; --nav:#1e3a8a; --acc1:#84cc16; --acc2:#0ea5e9; --strong:#d9f99d; --medium:#e0f2fe; --low:#f8fafc; --muted:#f3f4f6; }
    body{background: var(--bg);} thead.sticky th{position:sticky;top:0;z-index:10}
    th,td{vertical-align:middle}
    .nav-gradient{background: linear-gradient(90deg, var(--nav), #0c4a6e);}
    .badge{background: linear-gradient(90deg, var(--acc1), var(--acc2)); -webkit-background-clip: text; background-clip: text; color: transparent;}
    tr.edge-strong { background: var(--strong); }
    tr.edge-medium { background: var(--medium); }
    tr.edge-low    { background: var(--low); }
    tr.muted       { background: var(--muted); color:#6b7280; }
  </style>
`;
function siteHeader(active='home'){
  const link = (href, label) => `<a class="px-3 py-1.5 rounded text-white/90 hover:text-white" href="${href}">${label}</a>`;
  return `
    <header class="rounded-2xl nav-gradient text-white p-4 flex items-center justify-between">
      <h1 class="text-xl sm:text-2xl font-extrabold tracking-tight">
        BetEstimate<span class="badge">.com</span> — Today’s AI Football Picks
      </h1>
      <nav class="text-sm space-x-2">
        ${link('/', 'Home')}${link('/about','About')}${link('/privacy','Privacy')}${link('/contact','Contact')}
      </nav>
    </header>`;
}
const FOOTER = `<footer class="mt-8 text-[12px] text-slate-700"><div class="italic">Use the data at your own risk. Informational picks only — no guarantees.</div><div class="mt-2">© ${new Date().getFullYear()} BetEstimate.com</div></footer>`;

// ---- API & pages
app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});
app.get('/diag', async (_req, res) => {
  const fresh = await fetchFixturesToday();
  res.json({ tz: TZ, startHour: START_HOUR, hidePredictionless: HIDE_PREDICTIONLESS, total: fresh.count, sample: fresh.rows.slice(0,5) });
});
app.get('/diag-espn', async (_req, res) => {
  const out = await sourceEspnScheduleToday(TZ);
  res.json({ enabled: ENABLE_ESPN, looseMode: ESPN_LOOSE, debug: ESPN_DEBUG, url: out.meta?.url, count: out.meta?.count || 0, unknown: out.meta?.unknown || 0, sample: (out.rows || []).slice(0, 8) });
});

app.get('/', (_req, res) => {
  const HTML = `<!doctype html><html lang="en"><head><title>BetEstimate.com — Today’s AI Football Picks</title>${HEAD_META}</head>
  <body class="text-slate-900"><div class="max-w-7xl mx-auto p-4 space-y-4">
  <ins class="adsbygoogle" style="display:block" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
  ${siteHeader('home')}
  <div class="overflow-x-auto bg-white rounded-2xl shadow">
    <table class="min-w-full text-[13px] leading-tight" id="tbl">
      <thead class="bg-slate-100 sticky"><tr class="text-slate-700">
        <th class="text-left px-2 py-2">Kickoff</th>
        <th class="text-left px-2 py-2">League</th>
        <th class="text-left px-2 py-2">Home</th>
        <th class="text-left px-2 py-2">Away</th>
        <th class="text-left px-2 py-2">Prediction</th>
        <th class="text-left px-2 py-2">Alt pick</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="mt-3 text-[12px] text-slate-700 font-medium flex flex-wrap gap-4">
    <span class="inline-flex items-center"><span class="inline-block w-4 h-4 rounded mr-1" style="background:#d9f99d"></span>Strong (edge ≥ 10)</span>
    <span class="inline-flex items-center"><span class="inline-block w-4 h-4 rounded mr-1" style="background:#e0f2fe"></span>Medium (5–9)</span>
    <span class="inline-flex items-center"><span class="inline-block w-4 h-4 rounded mr-1" style="background:#f8fafc"></span>Low (&lt; 5)</span>
    <span class="inline-flex items-center"><span class="inline-block w-4 h-4 rounded mr-1" style="background:#f3f4f6"></span>No pick (shown only if HIDE_PREDICTIONLESS=0)</span>
  </div>
  ${FOOTER}
  </div>
  <script>
    function rowClass(edge, hasPick){ if(!hasPick) return 'muted'; if (edge >= 10) return 'edge-strong'; if (edge >= 5) return 'edge-medium'; return 'edge-low'; }
    async function load(){
      const res = await fetch("/api/today"); const data = await res.json();
      const rows = data.rows || [];
      document.getElementById("rows").innerHTML = rows.map(r => {
        const hasPick = !!(r.prediction && r.prediction.length);
        const edge = Number(r.primaryEdgePct||0);
        const cls = rowClass(edge, hasPick);
        return (
          "<tr class='border-b last:border-0 " + cls + "'>" +
            "<td class='px-2 py-2 whitespace-nowrap'>" + (r.kickoff||"") + "</td>" +
            "<td class='px-2 py-2'>" + (r.league||"") + "</td>" +
            "<td class='px-2 py-2 font-medium'>" + (r.home||"") + "</td>" +
            "<td class='px-2 py-2'>" + (r.away||"") + "</td>" +
            "<td class='px-2 py-2'>" + (r.prediction||"") + "</td>" +
            "<td class='px-2 py-2 opacity-80'>" + (r.altPrediction||"") + "</td>" +
          "</tr>"
        );
      }).join("");
    }
    load(); setInterval(load, 5*60*1000);
  </script></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML);
});

app.get('/about', (_req, res) => {
  const HTML = `<!doctype html><html lang="en"><head><title>About — BetEstimate.com</title>${HEAD_META}</head>
  <body class="text-slate-900"><div class="max-w-4xl mx-auto p-4 space-y-4">${siteHeader('about')}
  <main class="bg-white rounded-2xl shadow p-6 space-y-3 text-sm leading-6">
    <h2 class="text-xl font-semibold">About BetEstimate.com</h2>
    <p><strong>BetEstimate</strong> provides <em>AI football predictions</em> powered by statistical models and historical data. We combine Poisson goal models, Elo-like team strength, recent form, opponent strength, venue adjustment, and league scoring baselines to estimate probabilities for <strong>1X2</strong>, <strong>Over/Under 2.5</strong>, and <strong>BTTS</strong>.</p>
    <p>Popular topics: AI football predictions, betting insights, football data, match probabilities, sports analytics, daily football picks, BTTS, over/under goals.</p>
    <p><em>Important:</em> Predictions are informational only and not guarantees of any outcome. Use the data at your own risk.</p>
  </main>${FOOTER}</div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML);
});
app.get('/privacy', (_req, res) => {
  const HTML = `<!doctype html><html lang="en"><head><title>Privacy — BetEstimate.com</title>${HEAD_META}</head>
  <body class="text-slate-900"><div class="max-w-4xl mx-auto p-4 space-y-4">${siteHeader('privacy')}
  <main class="bg-white rounded-2xl shadow p-6 space-y-3 text-sm leading-6">
    <h2 class="text-xl font-semibold">Privacy Policy</h2>
    <p>We respect your privacy. BetEstimate.com may use cookies and basic web analytics to measure traffic and improve the site. If we enable Google AdSense or similar ad networks, those services may set cookies and use anonymous identifiers as described in their own policies.</p>
    <p>We do not collect personal information unless you choose to contact us. If you email us, your address and message will be used only to reply and will not be sold to third parties.</p>
    <p>By using this website, you consent to this policy. For questions, email <a class="underline" href="mailto:contact@betestimate.com">contact@betestimate.com</a>.</p>
  </main>${FOOTER}</div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML);
});
app.get('/contact', (_req, res) => {
  const HTML = `<!doctype html><html lang="en"><head><title>Contact — BetEstimate.com</title>${HEAD_META}</head>
  <body class="text-slate-900"><div class="max-w-4xl mx-auto p-4 space-y-4">${siteHeader('contact')}
  <main class="bg-white rounded-2xl shadow p-6 space-y-3 text-sm leading-6">
    <h2 class="text-xl font-semibold">Contact</h2>
    <p>Have a question or feedback? Email us at <a class="underline" href="mailto:contact@betestimate.com">contact@betestimate.com</a>.</p>
    <p>We usually respond within a few days.</p>
  </main>${FOOTER}</div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML);
});

app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}`);
  setTimeout(() => { warmCache().catch(e => console.error('[warmCache@boot] error', e)); }, 1200);
});
