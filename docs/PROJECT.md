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

Directional verdict from weighted lane scores → BULLISH / BEARISH / NEUTRAL.

Structure branch (given direction + IV regime from Options Flow):

| Direction | IV regime | Structure |
|-----------|-----------|-----------|
| Bullish | low / falling | Buy CE |
| Bullish | high / rising | consider Sell PE |
| Bearish | low / falling | Buy PE |
| Bearish | high / rising | consider Sell CE |

Sell/write recommendations must surface uncapped / large-loss risk explicitly.

**Note:** Sentiment + Macro lanes are stubbed (score 0) until Stage 2.5. Weighting is therefore partially heuristic until those lanes ship.

## 3. Scalp / Swing mode

| Mode | Timeframes | Weight emphasis |
|------|------------|-----------------|
| Scalp | 1m / 3m / 5m | OI-change velocity, momentum, liquidity |
| Swing | 15m / 1h / 1D | Trend strength, FII-DII, macro |

- Scalp flags low-liquidity strikes (wide bid-ask, low volume) as unsuitable.
- Swing surfaces days-to-expiry and Theta-vs-directional-gain warnings.
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

## 5. Lanes architecture

Each lane returns `{ score: -1..1, signals: string[], rawIndicators }`. Snapshots persist with every trade idea (additive schema).

## 6. Backtest / track record

- Time-ordered validation only (no shuffled train/test).
- Metrics per lane and per synthesis branch cohort.
- UI "edge" badges labeled **experimental / unvalidated** until meaningful multi-regime sample size.
- This is the evidence gate before any future real-money automation discussion (still out of scope).

## Shipped vs Not Yet

### Shipped
- Next.js App Router + TypeScript strict + Tailwind + React 19
- Framer Motion, Lucide, Prisma scaffold, Upstash Redis client, lightweight-charts
- Binance theme tokens (`src/lib/theme.ts` + CSS `@theme`)
- Folder structure (`marketdata/`, `lanes/`, `synthesis/`, `paperTrading/`, `backtest/`)
- docs/PROJECT.md + README + `.env.example`
- Stage 1: Angel One auth, LTP, candles, option chain, throttle/retry, `/api/marketdata/test`
- Stage 2: Technical + Options Flow lanes + `npm run test:lanes`
- Stage 2.5 stubs: Sentiment + Macro (neutral score 0 — labeled stubs)
- Stage 3: Directional + structure synthesis, TradeIdea model, analysis UI
- Stage 4: Scalp/Swing mode threaded through lanes + synthesizer + UI
- Stage 5: Paper trading models, P&L, expiry settlement cron, paper UI
- Stage 6: Time-ordered backtest cohorts + experimental track-record UI

### Not Yet
- Live Sentiment lane (news / FII-DII feeds)
- Live Macro lane (India VIX / USDINR / SGX Nifty / crude)
- TimescaleDB IV time-series store (IV trend currently from live + candle-derived proxy)
- Upstash Redis pub/sub for scalp second-level polling
- Real broker order placement (intentionally out of scope)

## External Data Sources

| Source | Used for | Cost | Rate limits / notes | Fallback |
|--------|----------|------|---------------------|----------|
| Angel One SmartAPI | Auth (TOTP), LTP, historical OHLCV, market quote FULL (OI/IV), scrip master for option chain | Free tier (SmartAPI app) | Session valid until midnight; historical intervals have day-range caps (e.g. ONE_MINUTE ≈ 30 days); throttle client to ~3–5 req/s; retry/backoff on 5xx/429 | Typed `MarketDataUnavailableError`; demo mock mode if credentials missing |
| OpenAPI Scrip Master JSON | Symbol tokens for NIFTY/BANKNIFTY/SENSEX options | Free public dump | Cache locally; refresh periodically | Cached file / demo strikes |
| Upstash Redis | Optional cache; future scalp pub/sub | Free tier limits apply | Per-plan | No-op client when env missing |

## Build order (reference)

0. Scaffold → 1. Angel One plumbing → 2. Technical + Options Flow → 2.5 Sentiment/Macro (future) → 3. Synthesis → 4. Scalp/Swing → 5. Paper → 6. Backtest
