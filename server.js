
// server.js
// ESPN-only tolerant parser version

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const {
  PORT = 3000,
  TZ = "Europe/Istanbul",
  START_HOUR = "0",
  ENABLE_ESPN = "1",
  ESPN_SCHEDULE_URL = "https://www.espn.com/football/fixtures/_/league/all",
  ESPN_LOOSE = "1",
  ESPN_DEBUG = "1",
  HIDE_PREDICTIONLESS = "0",
  ADSENSE_ACCOUNT = "",
  GOOGLE_SITE_VERIFICATION = ""
} = process.env;

function yyyymmddInTZ(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [dd, mm, yyyy] = fmt.formatToParts(date)
    .filter(p => ["day", "month", "year"].includes(p.type))
    .map(p => p.value);
  return `${yyyy}${mm}${dd}`;
}

function headerMap($, $table) {
  const heads = [];
  let headCells = $table.find("thead th");
  if (!headCells.length) headCells = $table.find("tr").first().find("th,td");
  headCells.each((i, th) => heads.push($(th).text().trim().toUpperCase()));
  const idx = { match: -1, time: -1 };
  heads.forEach((h, i) => {
    if (h.includes("MATCH") || h.includes("FIXTURE") || h.includes("MATCHUP") || h.includes("EVENT")) idx.match = i;
    if (h.includes("TIME") || h.includes("KICK") || /^ET$/.test(h) || /GMT|UTC/.test(h)) idx.time = i;
  });
  if (idx.match === -1 || idx.time === -1) {
    const firstRow = $table.find("tbody tr").first();
    const cells = firstRow.find("td");
    cells.each((i, td) => {
      const t = $(td).text().trim();
      if (idx.match === -1 && /( v | - |–|—)/i.test(t)) idx.match = i;
      if (idx.time === -1 && /\d{1,2}:\d{2}/.test(t)) idx.time = i;
    });
  }
  return idx;
}

function splitTeams(text) {
  const raw = (text || "").replace(/\s+/g, " ").trim();
  let parts = raw.split(/\sv\s/i);
  if (parts.length !== 2) parts = raw.split(/\s[-–—]\s/);
  if (parts.length !== 2) return { home: raw, away: "" };
  return { home: parts[0].trim(), away: parts[1].trim() };
}

async function sourceEspnScheduleToday() {
  if (ENABLE_ESPN !== "1") return [];
  const ymd = yyyymmddInTZ(TZ);
  const base = ESPN_SCHEDULE_URL.replace(/\/$/, "");
  const url = `${base}/_/date/${ymd}`;
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = res.data;
    const $ = cheerio.load(html);
    const tables = $("table");
    const rows = [];
    tables.each((ti, tbl) => {
      const $table = $(tbl);
      const idx = headerMap($, $table);
      if (idx.match === -1) return;
      let league = "Unknown Competition";
      const prevHeader = $table.prevAll("h2,h3,h4").first();
      if (prevHeader && prevHeader.length) league = prevHeader.text().trim() || league;
      if (league === "Unknown Competition" && ESPN_LOOSE !== "1") return;
      $table.find("tbody tr").each((ri, tr) => {
        const $cells = $(tr).find("td");
        if (!$cells.length) return;
        const matchCell = $cells.eq(idx.match).text().trim();
        if (!matchCell) return;
        const { home, away } = splitTeams(matchCell);
        if (!home) return;
        const timeStr = idx.time >= 0 ? $cells.eq(idx.time).text().trim() : "";
        rows.push({ league, date: ymd, time: timeStr, home, away });
      });
    });
    if (ESPN_DEBUG === "1") console.log(`[ESPN] URL: ${url} rows: ${rows.length}`);
    return rows;
  } catch (e) {
    console.error("[ESPN] fetch error:", e.message);
    return [];
  }
}

const CACHE = { updatedAt: null, rows: [] };

async function warmCache() {
  const rows = await sourceEspnScheduleToday();
  CACHE.rows = rows;
  CACHE.updatedAt = new Date().toISOString();
  console.log(`[warmCache] ${rows.length} rows`);
}

setTimeout(warmCache, 1200);
setInterval(warmCache, 30 * 60 * 1000);

const app = express();

app.get("/", (req, res) => {
  const rows = CACHE.rows || [];
  res.type("html").send(`<html><head><meta charset='utf-8'><title>Fixtures</title></head><body>
  <h1>ESPN Fixtures (${rows.length})</h1>
  <pre>${JSON.stringify(rows.slice(0, 5), null, 2)}</pre></body></html>`);
});

app.get("/diag-espn", async (req, res) => {
  const ymd = yyyymmddInTZ(TZ);
  const base = ESPN_SCHEDULE_URL.replace(/\/$/, "");
  const url = `${base}/_/date/${ymd}`;
  const rows = await sourceEspnScheduleToday();
  res.json({ url, count: rows.length, sample: rows.slice(0, 5) });
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Listening on ${PORT}`));
