# NSE Options Trading Assistant — Architecture

## Project summary

A Binance-styled web assistant for NSE index options (NIFTY, BANKNIFTY, SENSEX) that pulls Angel One SmartAPI market data, runs independent analysis lanes, synthesizes IV-aware Buy/Sell structure verdicts, supports Scalp vs Swing modes, paper-trades with correct options P&L, and tracks time-ordered backtest cohorts. Real-money automation is out of scope.

## Locked tech stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js (App Router), TypeScript strict |
| UI | React 19, Tailwind, Framer Motion, Lucide |
| Charts | lightweight-charts |
| Theme | Binance dark + gold tokens (`src/lib/theme.ts`) |
| ORM / DB | Prisma → Postgres (Supabase) |
| Cache / jobs | Upstash Redis |
| Market data | Angel One SmartAPI (TOTP login) |

## 2.5 Synthesis — IV-aware Buy/Sell branching

Directional verdict from weighted lane scores → BULLISH / BEARISH / NEUTRAL  
(`combinedScore ≥ +0.15` bullish · `≤ −0.15` bearish · else neutral / no trade).

### Scalp vs Swing lane weights

| Lane | Scalp | Swing |
|------|------:|------:|
| Options Flow | 0.45 | 0.25 |
| Technical | 0.35 | 0.40 |
| Sentiment | 0.10 | 0.15 |
| Macro | 0.10 | 0.20 |

Structure branch (given direction + IV regime from Options Flow):

| Direction | IV regime | Structure |
|-----------|-----------|-----------|
| Bullish | low / falling | Buy CE |
| Bullish | high / rising | consider Sell PE |
| Bearish | low / falling | Buy PE |
| Bearish | high / rising | consider Sell CE |

Sell/write recommendations must surface uncapped / large-loss risk explicitly.

**Note:** All four lanes (Technical, Options Flow, Macro, Sentiment) are live. Each lane's scoring remains rules-based / heuristic — not ML-validated — until Section 6 track-record evidence across regimes. UI default mode is **Scalp** (Analysis + Paper).

## 3. Scalp / Swing mode

| Mode | Timeframes | Weight emphasis |
|------|------------|-----------------|
| Scalp | 5m chart / technical | OI/volume skew near ATM, momentum, liquidity flags |
| Swing | 1h chart / technical | Trend strength, FII-DII, macro |

- Scalp flags low-liquidity strikes (wide bid-ask, low volume) as unsuitable.
- Swing surfaces days-to-expiry and Theta-vs-directional-gain warnings.
- Trade plan ATR multiples: Scalp **1.25×ATR**, Swing **2.25×ATR**; TP1/TP2 at 1:2 / 1:3 vs risk.
- Suggested contract: ATM-ish from live option chain for Mark as taken → paper.
- **TODO:** Scalp near-real-time polling (seconds) may need Upstash Redis pub/sub — not yet implemented; current path is request-time fetch.

## 4. Paper trading

### 4.1 PaperOptionsAccount
- `id`, `name`, `cashBalance`, `startingCash`, `createdAt`, `updatedAt`

### 4.2 OptionsPosition
- `underlying`, `strike`, `optionType` (CE/PE), `expiry`, `action` (BUY/SELL)
- `lotSize`, `lots`, `entryPremium`, `status` (OPEN/CLOSED/EXPIRED)
- `exitPremium`, `realizedPnl`, `mode` (SCALP/SWING), timestamps

### P&L
- Buy: `(exit - entry) * lotSize * lots` — max loss capped at premium paid
- Sell/write: `(entry - exit) * lotSize * lots` — CE uncapped; PE large (strike-bounded intrinsic)

Expiry settlement (idempotent): intrinsic `max(0, spot-strike)` CE / `max(0, strike-spot)` PE.

### Persistence resilience
- Primary store: Postgres via Prisma when `DATABASE_URL` is set.
- On successful DB read, account is mirrored to in-memory cache + `.data/paper-account.json`.
- On Supabase/pooler blips: serve memory → file mirror (dashboard P&L should not hard-fail after a good read).
- Without `DATABASE_URL`: file-backed store only.
- `/api/paper` GET returns 503 only if DB and mirrors are all unavailable; client retries with backoff + Retry control.

## 5. Lanes architecture

Each lane returns `{ score: -1..1, signals: string[], rawIndicators }`. Snapshots persist with every trade idea (additive schema).

- **Technical:** EMA50/200, RSI(14), patterns, ATR; Scalp adds short momentum on 5m.
- **Options Flow:** PCR, Max Pain, IV level/trend, OI notes; Scalp adds ATM call/put volume skew + liquidity flags.
- **Sentiment:** FII/DII cash net (65%) + news bias (35%); Scalp dampens FII lag vs fresher news.
- **Macro:** Gift Nifty, India VIX, USDINR, US overnight, crude, DXY; Scalp leans Gift/VIX slightly harder.

## 6. Backtest / track record

- Time-ordered validation only (no shuffled train/test).
- Metrics per lane and per synthesis branch cohort.
- **Synthesis-version cohort split (post Stage 2.5a/2.5b):** records are tagged `lanes-v1-2lane-effective` (legacy — Macro/Sentiment stubbed at 0) vs `lanes-v2-4lane` (current). Headline / experimental edge badges use the post-4-lane cohort only; legacy is shown separately and never pooled into current-system win rates.
- Post-4-lane edge metrics need ≥10 resolved outcomes before a win-rate is treated as reportable; until then the UI shows insufficient sample (does not fall back to legacy %).
- Per-lane lean buckets cover Technical, Options Flow, Macro, and Sentiment going forward (legacy seeds often lack Macro/Sentiment scores).
- UI "edge" badges labeled **experimental / unvalidated** until meaningful multi-regime sample size.
- This is the evidence gate before any future real-money automation discussion (still out of scope).
- Expiry settlement cron (`settle:expiry` / `/api/cron/settle-expiry`) is unchanged — idempotent paper settlement only; it does not write track-record cohorts.

## 7. UI / responsive shell

| Viewport | Nav | Notes |
|----------|-----|-------|
| Mobile (`< md`) | Fixed bottom tabs (`MobileBottomNav`: Home / Analysis / Paper / Record) | Compact sticky header (“NSE Options”), safe-area insets, footer hidden, app-like padding under tabs |
| Desktop (`≥ md`) | Top header links | Footer disclaimer visible |

Theme tokens only — no hardcoded Binance hex in components (`src/lib/theme.ts` / `binance-*` Tailwind).

## Shipped vs Not Yet

### Shipped
- Next.js App Router + TypeScript strict + Tailwind + React 19
- Framer Motion, Lucide, Prisma scaffold, Upstash Redis client, lightweight-charts
- Binance theme tokens (`src/lib/theme.ts` + CSS `@theme`)
- Folder structure (`marketdata/`, `lanes/`, `synthesis/`, `paperTrading/`, `backtest/`)
- docs/PROJECT.md + README + `.env.example`
- Stage 1: Angel One auth, LTP, candles, option chain, throttle/retry, `/api/marketdata/test`
- Stage 2: Technical + Options Flow lanes + `npm run test:lanes`
- Stage 2.5a: Live Macro lane — weighted heuristic from cached dashboard macro quotes (VIX, USDINR, Gift Nifty, US overnight, crude, DXY); degrades to score 0 on fetch failure
- Stage 2.5b: Live Sentiment lane — FII/DII cash net (NSE `fiidiiTradeReact`, Mr Chartist fallback) + news BULL/BEAR aggregate from shared RSS cache; independent sub-signal degrade; all four lanes live
- Stage 3: Directional + structure synthesis, TradeIdea model, analysis UI
- Stage 3.1: Synthesized verdict card — ATR trade plan (Entry/SL/TP1/TP2 + R:R), regime (TRENDING/CHOPPY/VOLATILE), lane alignment, experimental edge from track-record (no ML), Mark as taken → paper
- Stage 3.2: Analysis **50/50** layout — verdict left, live candlestick chart right (`AnalysisLiveChart` / `lightweight-charts`). Candles from `/api/analysis/candles` (prefer Yahoo timed OHLC so series matches live spot; Angel when available / non-demo). Forming bar patched from dashboard SSE LTP only when within **0.5%** of last close (avoids mock↔live crash candle). Dashed Entry / SL / TP1 / TP2 price lines after synthesis. UI default mode **Scalp**.
- Stage 4: Scalp/Swing mode threaded through lanes + synthesizer + UI
- Stage 5: Paper trading models, P&L, expiry settlement cron, paper UI; paper account load hardened (DB retry + memory/file mirror)
- Stage 6: Time-ordered backtest cohorts + experimental track-record UI
- Stage 6.1: Backtest re-validation after 4-lane synthesis — `synthesisVersion` cohort split (legacy 2-lane-effective vs post-4-lane); edge badges use post-4-lane only with insufficient-sample gating; per-lane lean includes Macro + Sentiment
- Dashboard (default `/`): Binance-style paper portfolio P&L header (`PortfolioPnlCard` — est. total value, today’s PnL, gold equity sparkline, hide-balance toggle, client retry) above index quote cards for Nifty 50, Bank Nifty, Sensex, Gift Nifty + mini candles (`/api/dashboard`). **Live path:** backend `liveQuoteHub` — fast public spot loop ~350ms (NSE `allIndices` + Gift, no Yahoo) pushed via SSE `/api/dashboard/stream`; full candle snapshot ~30s. Browser `EventSource` (check Network → EventStream, not Fetch/XHR). With `MARKETDATA_DEMO_MODE=true` / missing Angel keys, LTP is public-feed delayed (not broker ticks). Pulsing **LIVE** badge + price flash when LTP changes.
- Responsive app shell: mobile bottom tab nav + safe-area; desktop top nav + footer (see §7).
- Dashboard macro strip (`/api/dashboard/macro`): Gift Nifty proxy, India VIX (NSE/Yahoo), US (Dow/Nasdaq/S&P), Asian indices, WTI/Brent crude, DXY, USDINR; this-week economic highlights (Fed/CPI/GDP/NFP/RBI when present); today’s news via Google/Yahoo RSS. Free unofficial APIs — no paid keys. News/events show heuristic **BULL / BEAR / MIXED** bias pills (keyword + print-vs-forecast; labeled experimental). Macro quotes auto-refresh ~15s (LIVE badge; pauses when tab hidden).
- Paper option chain: live NSE India OC for NIFTY/BANKNIFTY (Call/Put LTP + OI + % change, ~20s refresh); Groww-style spot marker between strikes.

### Not Yet
- Live Gift Nifty via SmartAPI (instrument absent from scrip master; dashboard uses free giftcitynifty.com NSE IX feed, with Nifty proxy fallback)
- TimescaleDB IV time-series store (IV trend currently from live + candle-derived proxy)
- Upstash Redis pub/sub for scalp second-level polling
- Angel One SmartAPI WebSocket tick stream (dashboard uses server SSE + free public LTP)
- Real broker order placement (intentionally out of scope)

## External Data Sources

| Source | Used for | Cost | Rate limits / notes | Fallback |
|--------|----------|------|---------------------|----------|
| Angel One SmartAPI | Auth (TOTP), LTP, historical OHLCV, market quote FULL (OI/IV), scrip master for option chain | Free tier (SmartAPI app) | Session valid until midnight; historical intervals have day-range caps (e.g. ONE_MINUTE ≈ 30 days); throttle client to ~3–5 req/s; retry/backoff on 5xx/429 | Typed `MarketDataUnavailableError`; demo mock mode if credentials missing |
| OpenAPI Scrip Master JSON | Symbol tokens for NIFTY/BANKNIFTY/SENSEX options | Free public dump | Cache locally; refresh periodically | Cached file / demo strikes |
| Gift Nifty (NSE IFSC / NSE IX) | Dashboard + Macro lane Gift Nifty premium/discount cue | Free via `live.giftcitynifty.com/api/gift-nifty` | Soft limits; unofficial mirror of NSE IX; shared `getCachedMacroQuotes` TTL ~12s | Labeled Nifty 50 proxy if feed down; Macro lane omits Gift component |
| Yahoo Finance chart API | Dashboard LTP + 5m candles for ^NSEI / ^NSEBANK / ^BSESN; macro quotes (US/Asia indices, ^INDIAVIX, CL=F, BZ=F, DX-Y.NYB, INR=X) for dashboard strip **and** Macro lane scoring; **Analysis live chart** timed OHLC (`5m`/`60m` via `/api/analysis/candles` → `getPublicAnalysisCandles`) | Free unofficial | Soft rate limits; may 429; `/v7/quote` often Unauthorized — use `/v8/finance/chart`; analysis candles TTL ~20s | NSE `allIndices` spot for Nifty/Bank Nifty/India VIX; Macro lane score 0 + `"macro data unavailable"` if all feeds fail; analysis chart: Angel OHLC when non-demo, else 503 |
| NSE India `allIndices` | Dashboard near-live LTP for Nifty / Bank Nifty / Sensex; India VIX spot (dashboard + Macro lane preferred VIX source); SSE forming-bar patch for analysis chart | Free public | Cookie/UA soft limits; ~1.5s in-process TTL coalesce | Yahoo chart; labeled demo; Macro lane omits VIX component if both fail |
| Forex Factory week JSON (`nfs.faireconomy.media`) | Dashboard economic calendar (Fed/CPI/GDP/NFP; RBI when listed) | Free unofficial mirror | Soft limits; INR/RBI coverage sparse | Empty buckets + UI note |
| Google News RSS + Yahoo Finance RSS | Dashboard “Today's News” + Sentiment lane headline bias aggregate | Free public RSS | Soft limits / regional variance; shared `getCachedMarketNews` TTL ~5m | Empty list + UI note; Sentiment omits news component and scores from FII/DII only |
| NSE India `fiidiiTradeReact` | Sentiment lane daily FII/DII cash net (₹ Cr) | Free public | Cookie/UA soft limits; provisional figures; shared TTL ~15m | Mr Chartist mirror; Sentiment omits FII/DII component if both fail |
| Mr Chartist FII/DII API (`fii-diidata.mrchartist.com/api/data`) | Sentiment lane FII/DII fallback (NSE-sourced mirror) | Free unofficial | Soft / polite limits; evening provisional | Sentiment news-only partial score if this and NSE both fail |
| NSE India `option-chain-v3` + `option-chain-contract-info` | Live option chain LTP / OI / IV / % change for NIFTY & BANKNIFTY | Free public | Cookie session + soft rate limits; SENSEX not on this API | Angel One quote FULL; then labeled demo mocks |
| Postgres (Supabase) via Prisma | Paper account, positions, trade ideas, backtest outcomes | Per Supabase plan | Pooler cold starts / network blips | In-memory + `.data/paper-account.json` mirror after successful read; file-only store if no `DATABASE_URL` |
| Upstash Redis | Optional cache; future scalp pub/sub | Free tier limits apply | Per-plan | No-op client when env missing |

## Build order (reference)

0. Scaffold → 1. Angel One plumbing → 2. Technical + Options Flow → 2.5a Live Macro (done) → 2.5b Live Sentiment (done) → 3. Synthesis → 3.1 Trade plan UI → 3.2 Analysis live chart → 4. Scalp/Swing → 5. Paper → 6. Backtest → responsive shell + paper resilience
