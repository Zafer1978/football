# BetEstimate AIPicks v5.5.4

Small Node.js/Express server that fetches football fixtures from ESPN and/or football-data.org,
parses them with Cheerio, and serves JSON + a tiny HTML UI.

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

The server listens on `0.0.0.0:3000` by default (configure via `.env`).

## Environment variables

See `.env.example` for documented options. The most important:

- `ENABLE_ESPN=1` — enable ESPN HTML schedule parsing
- `ESPN_SCHEDULE_URL=https://www.espn.com/soccer/schedule`
- `FOOTBALL_DATA_KEY=` — optional token for football-data.org
- `HIDE_PREDICTIONLESS=0|1` — hide rows without model predictions (set `0` to see ESPN schedule-only rows)
- `TZ=Europe/Istanbul` — runtime timezone
- `START_HOUR=0` — warm cache starting hour (0–23)

## Endpoints

- `GET /api/fixtures` — JSON of cached fixtures
- `GET /diag-espn` — debug view to verify ESPN table parsing
- `GET /` — simple HTML viewer
- `GET /about`, `/privacy`, `/contact` — basic informational pages

## Common issue: `ReferenceError: $ is not defined`

If you see this in Render logs, it means the Cheerio `$` instance was not in scope for helper functions.
This repo fixes it by passing `$` into `headerMap($, $table)` and at call sites.

## Deploying on Render

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Runtime:** Node 20
- Add environment variables from `.env.example` in your Render service settings.
- If you only see a handful of rows, set `HIDE_PREDICTIONLESS=0` so ESPN schedule rows are visible.

## License

MIT (or your choice).


### Form-based primary predictions
Set in your environment:
```
PREDICT_USING_FORM=1
```
This promotes the **last-5 matches form pick** to the primary prediction (the model’s pick, if any, is moved to Alt).
