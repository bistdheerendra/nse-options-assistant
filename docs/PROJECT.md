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
| Bearish | any (low/mid/high) | **Buy PE** (Sell CE disabled — prefer long put with capped debit risk) |

On bearish + high/rising IV the UI still warns that put premium is rich (size smaller) but does **not** switch to Sell CE. Sell/write recommendations (bullish Sell PE path) must still surface large-loss risk explicitly.

**Note:** All four lanes (Technical, Options Flow, Macro, Sentiment) are live. Each lane's scoring remains rules-based / heuristic — not ML-validated — until Section 6 track-record evidence across regimes. UI default mode is **Scalp** (Analysis + Paper).

### SCALP Technical raw-term weights (5m)

| Term | Weight | Notes |
|------|-------:|-------|
| EMA50/200 stack (regime) | ±0.25 | Was ±0.35; reduced to make room for fast cross. Still multi-session lag on 5m. |
| Fast EMA10/20 cross | ±0.20 | SCALP only — same-session momentum. Flat ± v1; ATR-scaled magnitude is a possible refinement. |
| Price vs EMA50 | ±0.20 | Unchanged |
| RSI(14) | ±0.25 or mild | Unchanged |
| Candle patterns | ±0.15 | Unchanged |
| Scalp momentum (5 bars) | up to ±0.30 | Unchanged |

SWING keeps EMA50/200 at `EMA_STACK_BASE_WEIGHT = 0.35` and has **no** fast 10/20 term.

### SCALP EMA regime dampen (`EMA_DAMPEN_FACTOR`)

On SCALP only, classic Technical still scores EMA50/200 on **5m** bars (`EMA_STACK_SCALP_WEIGHT = 0.25`). That stack is multi-session lag even on 5m. After Stage-8 `scalpSignal` is built — and **before** `technicalBiasAdj` — if `timeframeConfluence.dominant` is **opposite** to the EMA stack direction **and** all three of `{3m, 5m, 15m}` agree on that dominant (1m excluded), the EMA term is multiplied by `EMA_DAMPEN_FACTOR = 0.5` (e.g. +0.25 → +0.125). Fast EMA10/20 is **not** dampened. SWING is unchanged. Stage-8 `technicalBiasAdj` formula and the ±0.15 neutral threshold are unchanged.

### SCALP “lanes disagree” badge (UI only)

When SCALP verdict is NEUTRAL / structure `NO_TRADE` and Technical vs Options Flow have **opposite signs** with `|tech − flow| > 0.4`, the Analysis verdict card shows **“Lanes disagree — Technical vs Options Flow”**. Does not change the trade decision.

## 3. Scalp / Swing mode

| Mode | Timeframes | Weight emphasis |
|------|------------|-----------------|
| Scalp | 5m chart / technical | OI/volume skew near ATM, momentum, liquidity flags |
| Swing | 1h chart / technical | Trend strength, FII-DII, macro |

- Scalp flags low-liquidity strikes (wide bid-ask, low volume) as unsuitable.
- Swing surfaces days-to-expiry and Theta-vs-directional-gain warnings.
- Trade plan ATR multiples: Scalp **1.25×ATR**, Swing **2.25×ATR**; TP1/TP2 at 1:2 / 1:3 vs risk.
- Suggested contract: ATM-ish from live option chain for Mark as taken → paper.
- **TODO:** Scalp near-real-time polling (seconds) may need Upstash Redis pub/sub — not yet implemented; current path is request-time fetch + periodic `poll:scalp-candles` job.

### 3.1 Scalping Mode — multi-timeframe candle pipeline (Stage 1)

**Purpose:** Feed later price-action / volume / confirmation stages with synchronized 1m · 3m · 5m · 15m OHLCV for NIFTY / BANKNIFTY / SENSEX.

**Angel One intervals (verified SmartAPI Historical docs):**
`ONE_MINUTE` | `THREE_MINUTE` | `FIVE_MINUTE` | `FIFTEEN_MINUTE`
Max days / request: 30 / 60 / 100 / 200 respectively. We request shorter windows so responses stay under the practical ~500-bar ceiling:

| Interval | Lookback days used |
|----------|-------------------:|
| ONE_MINUTE | 2 |
| THREE_MINUTE | 5 |
| FIVE_MINUTE | 5 |
| FIFTEEN_MINUTE | 10 |

**Data flow**
1. `getMultiTimeframeCandles(underlying)` fetches the four intervals **sequentially** (Angel `angelThrottle` ~250ms + `SCALP_POLL_GAP_MS` 350ms between TFs).
2. Best-effort idempotent upsert into Postgres `MarketCandle` (`@@unique([underlying, interval, time])`) when `DATABASE_URL` is set.
3. In-process TTL (~45s) + optional Upstash Redis key `scalp:mtf:{underlying}` coalesce request-time callers.
4. Job: `npm run poll:scalp-candles` walks all three underlyings with an extra ~800ms gap — force-refresh, no silent parallel hammering.
5. API: `GET /api/scalp/candles?underlying=NIFTY` (optional `&interval=ONE_MINUTE`).

**Storage note:** Locked stack is Prisma → Postgres (Supabase). Timescale hypertables are **not** wired; `MarketCandle` is a normal Postgres table suitable for scalp lookbacks. Timescale remains listed under Not Yet for longer IV/candle history.

**Fallback when Angel is rate-limited / down**
1. Serve last good `MarketCandle` rows (`source: db_cache`) and mark `degraded: true` with reason.
2. If no DB rows: empty series + degrade reason; UI should show “market data unavailable”.
3. Demo / missing credentials: labeled `source: "demo"` mocks (never silent stubs).

### 3.1b Scalping Mode — price action + patterns (Stage 2)

**Module:** `src/lib/marketdata/scalp/priceAction.ts` (pure; no verdict).

**Per timeframe** (`ONE_MINUTE` … `FIFTEEN_MINUTE`) output:
- `patterns[]` / `primaryPattern` — engulfing (bull/bear), doji, hammer, shooting star, inside bar
- `structureBias` / `structureSequence` — swing high/low (lookback=3) → HH_HL (bullish) / LH_LL (bearish) / mixed ranging / insufficient
- `candleStrength` ∈ [0,1] = `0.5*(body/range) + 0.5*((close−low)/range)`; `candleDirection` ∈ {−1,0,+1}
- `signals[]` — human-readable crumbs for UI / synthesizer later

**Rules (auditable):**
- Doji: `|close−open|/(high−low) < 0.1`
- Hammer: lower wick > 2× body AND upper wick ≤ body
- Shooting star: upper wick > 2× body AND lower wick ≤ body
- Inside bar: `high < prev.high AND low > prev.low`
- Engulfing: current body fully covers prior body with opposite color
- Structure eps: 0.02% of price so index micro-noise does not flip HH/HL

**API:** `GET /api/scalp/candles?underlying=NIFTY&priceAction=1`  
**Test:** `npm run test:scalp-pa`

This stage does **not** emit Buy/Sell — confluence is consumed by Stage 8 synthesizer weighting.

### 3.1c Scalping Mode — volume confirm / disqualify (Stage 3)

**Module:** `src/lib/marketdata/scalp/volume.ts`

Volume is **never** a standalone directional signal. It only adjusts confidence from Stage 2 price-action.

| Parameter | Value | Meaning |
|-----------|------:|---------|
| `VOLUME_LOOKBACK` | 20 | Rolling mean of prior 20 completed bars (excludes current) |
| `VOLUME_SPIKE_MULT` | 1.5 | `current ≥ 1.5 × avg` → spike (confirm when candle has direction) |
| `VOLUME_WEAK_MULT` | 0.6 | `current < 0.6 × avg` → weak (disqualify pressure) |
| `VOLUME_CONFIRM_BOOST` | +0.15 | Added to confidence on directional spike |
| `VOLUME_WEAK_PENALTY` | −0.25 | Subtracted on weak volume |

`ratio = currentVolume / avgVolume`. Adjusted confidence clamped to [0, 1].

**API:** `GET /api/scalp/candles?underlying=NIFTY&volume=1` (also runs price-action seed)  
**Test:** `npm run test:scalp-volume`

### 3.1d Scalping Mode — liquidity zones (Stage 4)

**Module:** `src/lib/marketdata/scalp/liquidity.ts` · UI: `LiquidityStatusBadge`

Strike-level liquidity from option chain **bid/ask + volume + OI** (Angel quote `FULL` / NSE OC — both expose these fields in-repo).

| Parameter | Value | Rule |
|-----------|------:|------|
| ATM band | ±1.5% spot | Scalp-relevant strikes only |
| Wide spread | `(ask−bid)/ltp > 8%` | Illiquid |
| Tight spread | `≤ 3%` | Good (with volume/OI) |
| Min volume | 100 | Below → low volume |
| Min OI | 5,000 | Below → thin OI |

**Hard gate:** ATM focus contract unsuitable → status `fail` / badge **"Unsuitable for scalping"** (not a muted number). Mixed band → `warn`. Clean → `pass`.

Wired into `runSynthesis` (`scalpLiquidity`) + Analysis verdict header badge + bearish callout on fail. Options Flow scalp path reuses the same assessor.

### 3.1e Scalping Mode — stop-loss clusters / S-R (Stage 5)

**Module:** `src/lib/marketdata/scalp/stopLossClusters.ts`

Levels from: recent swing high/low (lookback=3), round-number steps (NIFTY 50 / BN 100 / SENSEX 100), OI walls (PE max ≤ spot = support; CE max ≥ spot = resistance). Merged within 0.05% of spot; kept within ±2% of spot.

**Chart:** solid horizontals on `AnalysisLiveChart` — **blue** support (`theme.clusterSupport`) / **violet** resistance (`theme.clusterResistance`) — deliberately not candle bull/bear greens/reds. Trade-plan Entry/SL/TP stay dashed gold/bear/bull.

**Test:** `npm run test:scalp-clusters`

### 3.1f Scalping Mode — OI velocity (Stage 6)

**Module:** `src/lib/marketdata/scalp/oiVelocity.ts`

Reuses §2.2 OI wall heuristic, then adds **velocity**:
`velocityPerMin = (oiNow − oiPrev) / elapsedMinutes` over near-ATM (±1.5%) CE/PE.
Target spacing `OI_VELOCITY_TARGET_MINUTES = 5`. First snapshot (or <30s elapsed) → `warming_up` (never fabricates velocity). Notable when `|net CE−PE velocity| ≥ 2000 OI/min`.

In-process prior snapshot map (single-instance). Synthesis attaches `oiVelocity` on SCALP runs.

**Test:** `npm run test:scalp-oi`

### 3.1g Confirmation candle (Stage 7)

**Module:** `src/lib/marketdata/scalp/confirmationCandle.ts`

**Default rule (configurable):**
- Trigger TF: `FIVE_MINUTE` (`SCALP_CONFIRM_TIMEFRAME`)
- Signal bar = closed bar[-2]; confirm bar = closed bar[-1]
- Bullish: confirm close **>** signal high; bearish: confirm close **<** signal low (`SCALP_CONFIRM_CLOSE_BEYOND`)
- Rising volume: confirm.volume > signal.volume (`SCALP_CONFIRM_RISING_VOLUME`)
- Status: `pending` | `confirmed` | `failed` | `none`

**Audit note:** `confirmed` = rule pass only. UI reliability note states this is **not** a validated edge.

**Test:** `npm run test:scalp-confirm`

### 3.1h Scalp signal synthesis + card (Stage 8)

**Module:** `src/lib/marketdata/scalp/scalpSignal.ts` · UI: `ScalpSignalCard`

Combines Stages 2–7 into one card (TF confluence, pattern, volume role, liquidity badge, nearest SL clusters, OI velocity, confirmation status).  
`technicalBiasAdj` is added into the **existing** technical lane score before §2.5 weighted synthesis (SCALP weights unchanged: Flow 0.45 / Tech 0.35 / Sent 0.10 / Macro 0.10) — no second scorer.

**EMA dampen (SCALP):** If confluence `dominant` opposes the classic EMA50/200 stack and 3m+5m+15m all agree, apply `EMA_DAMPEN_FACTOR` (0.5) to that EMA term **before** adding `technicalBiasAdj` (see §2.5). Helpers: `applyScalpEmaStackDampen` in `src/lib/lanes/technical.ts`. Fast EMA10/20 (`FAST_EMA_TERM_WEIGHT`) is separate and not dampened.

Actionable only when confirm=`confirmed` AND liquidity≠`fail` AND volume≠`disqualify` — still labeled heuristic.

### 3.1i Auto paper on actionable scalp

**Opt-in** (default OFF): Analysis UI toggle **Auto paper on actionable scalp** (~60s poll while Scalp mode).  
Server: `POST/GET /api/cron/scalp-auto-paper` → `runScalpAutoPaper()` — paper only, never Angel placeOrder.

Gates: `scalpSignal.actionable` + structure BUY/SELL + suggestedContract + no duplicate OPEN (same underlying/strike/CE|PE/action).  
SELL also needs UI “Allow auto Sell/write” **or** `SCALP_AUTO_PAPER_ACK_SELL=true`.  
`entrySnapshot.autoPaper=true` + scalp feature tags for track record.

## 4. Paper trading

### 4.1 PaperOptionsAccount
- `id`, `name`, `cashBalance`, `startingCash`, `createdAt`, `updatedAt`

### 4.2 OptionsPosition
- `underlying`, `strike`, `optionType` (CE/PE), `expiry`, `action` (BUY/SELL)
- `lotSize`, `lots`, `entryPremium`, `status` (OPEN/CLOSED/EXPIRED)
- Premium `stopLoss` / `takeProfit` — derived from the **same spot Entry/SL/TP1** shown on the Analysis verdict card when Mark as taken / auto-paper opens a position:
  - **With delta (preferred):** Angel `/optionGreek` delta for the suggested strike/type rides on the option-chain fetch. `projectedPremium(spot) = entryPremium + delta × (spot − entrySpotAtSignal)` (clamped ≥ 0). SL = f(stopLossSpot), TP = f(tp1Spot); optional `entrySnapshot.takeProfit2` from tp2Spot. Linear delta is an approximation for small moves only (UI: “approx., delta-based”).
  - **Without delta (fallback):** when Greeks are null (off-hours AB9019, API down, demo, missing strike) → BUY SL=0.6·entry TP=1.8·entry (SELL mirrored 1.4 / 0.2); UI labels **est. — no delta**. Spot levels still persisted on `entrySnapshot` for audit.
  - Manual Paper-page opens (no verdict spots) keep explicit SL/TP or the same multiplier defaults.
- Paper page SL/TP are therefore premium-derived from the Analysis card’s spot levels (not an independent plan) when those spots were supplied at open.
- `entrySnapshot` additive fields: `entrySpotAtSignal`, `stopLossSpot`, `tp1Spot`, `tp2Spot`, `delta`, `slTpSource` (`delta` | `multiplier_fallback`), `takeProfit2`.
- Persisted on position columns + `entrySnapshot` (run `npm run db:push` after pull for dedicated columns).
- `closeReason` (`MANUAL` | `TP` | `SL` | `EXPIRED`) — TP/SL auto-close moves row to Closed
- `exitPremium`, `realizedPnl`, `mode` (SCALP/SWING), `openedAt` / `closedAt` (UI shows live duration)

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

- **Technical:** EMA50/200, RSI(14), patterns, ATR; Scalp adds fast EMA10/20 cross (±0.20), short momentum on 5m, and EMA50/200 at ±0.25 (vs Swing ±0.35).
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
| Mobile (`< md`) | Fixed bottom tabs (`MobileBottomNav`: Home / Analysis / Chart / Paper / Record) | Compact sticky header (“NSE Options”), safe-area insets, footer hidden, app-like padding under tabs |
| Desktop (`≥ md`) | Top header links | Footer disclaimer visible |

Theme tokens only — no hardcoded Binance hex in components (`src/lib/theme.ts` / `binance-*` Tailwind).

### 7.1 Market session hours (IST)

**Module:** `src/lib/marketdata/marketHours.ts`

Heuristic regular cash-session labels + open/closed check on the Asia/Kolkata wall clock (no exchange holiday calendar).

| Helper | Role |
|--------|------|
| `marketHoursForId(id)` | Session spec (open/close minutes or nearly-24h) keyed by quote id |
| `isMarketOpenNow(id)` | True during regular session; weekends closed except nearly-24h products; overnight wraps (e.g. US ET → IST) |
| `hoursIstForQuote(id)` | Display label, e.g. `9:15 AM – 3:30 PM IST` |
| `isUsEasternDaylightTime()` | Switches US equity IST window EDT vs EST |

**Coverage:** NSE indices + India VIX (9:15–15:30), Gift Nifty overnight, Asian equities, USDINR cash window, US (DJI/IXIC/GSPC/VIX) via ET→IST, crude/DXY as nearly 24h.

**UI:** `IndexQuoteCard` (dashboard index cards) and `MacroDashboard` quote tiles show the hours line; **gold + ●** when session open, muted when closed. Client re-ticks ~30s so open/closed colors stay current without a full data refetch.

## Shipped vs Not Yet

### Shipped
- Next.js App Router + TypeScript strict + Tailwind + React 19
- Framer Motion, Lucide, Prisma scaffold, Upstash Redis client, lightweight-charts
- Binance theme tokens (`src/lib/theme.ts` + CSS `@theme`)
- Folder structure (`marketdata/`, `lanes/`, `synthesis/`, `paperTrading/`, `backtest/`)
- docs/PROJECT.md + README + `.env.example`
- Stage 1: Angel One auth, LTP, candles, option chain, throttle/retry, `/api/marketdata/test`
- Scalp Stage 1: Multi-TF candle pipeline (`src/lib/marketdata/scalp/`) — Angel 1m/3m/5m/15m sequential fetch, Postgres `MarketCandle` upsert, Redis/TTL cache, `GET /api/scalp/candles`, `npm run poll:scalp-candles`; DB-cache / demo degrade path documented in §3.1
- Scalp Stage 2: Per-TF price action (`priceAction.ts`) — engulfing/doji/hammer/shooting-star/inside-bar + HH/HL structure + candle strength; `?priceAction=1` on scalp candles API; `npm run test:scalp-pa`
- Scalp Stage 3: Volume confirm/disqualify (`volume.ts`) — lookback=20, spike≥1.5×avg, weak<0.6×avg; adjusts PA confidence (±0.15 / −0.25); `?volume=1`; `npm run test:scalp-volume`
- Scalp Stage 4: Liquidity gate (`liquidity.ts` + `LiquidityStatusBadge`) — spread/volume/OI ATM-band; hard unsuitable-for-scalping fail; synthesis `scalpLiquidity`; `npm run test:scalp-liquidity`
- Scalp Stage 5: SL-cluster / S-R (`stopLossClusters.ts`) — swings + round numbers + OI walls; chart blue/violet horizontals (not candle colors); `npm run test:scalp-clusters`
- Scalp Stage 6: OI velocity (`oiVelocity.ts`) — ΔOI/minutes near ATM; warming_up until prior snapshot; synthesis `oiVelocity`; `npm run test:scalp-oi`
- Scalp Stage 7: Confirmation candle (`confirmationCandle.ts`) — next closed 5m bar beyond trigger + rising volume; env-configurable; `npm run test:scalp-confirm`
- Scalp Stage 8: Scalp signal card (`scalpSignal.ts` + `ScalpSignalCard`) — confluence/pattern/volume/liquidity/clusters/OI/confirm in one place; bias feeds existing §2.5 synthesizer
- SCALP EMA dampen: when Stage-8 MTF confluence (3m+5m+15m) strongly opposes classic EMA50/200 stack, multiply EMA term by `EMA_DAMPEN_FACTOR` (0.5) before `technicalBiasAdj`; SWING untouched
- SCALP fast EMA10/20 momentum term (`FAST_EMA_TERM_WEIGHT = 0.20`) on same 5m series; EMA50/200 SCALP base weight 0.35 → 0.25 (`EMA_STACK_SCALP_WEIGHT`); SWING stays 50/200 only at 0.35
- SCALP Analysis UI: “Lanes disagree — Technical vs Options Flow” badge on NEUTRAL/NO_TRADE when Tech vs OF opposite signs and |Δ| > 0.4 (context only — still NO_TRADE)
- Scalp auto-paper (opt-in): UI toggle + `/api/cron/scalp-auto-paper` opens paper when rule stack cleared; dedupe OPEN; sell ack required; paper only
- Stage 2: Technical + Options Flow lanes + `npm run test:lanes`
- Stage 2.5a: Live Macro lane — weighted heuristic from cached dashboard macro quotes (VIX, USDINR, Gift Nifty, US overnight, crude, DXY); degrades to score 0 on fetch failure
- Stage 2.5b: Live Sentiment lane — FII/DII cash net (NSE `fiidiiTradeReact`, Mr Chartist fallback) + news BULL/BEAR aggregate from shared RSS cache; independent sub-signal degrade; all four lanes live
- Stage 3: Directional + structure synthesis, TradeIdea model, analysis UI
- Stage 3.1: Synthesized verdict card — ATR trade plan (Entry/SL/TP1/TP2 + R:R), regime (TRENDING/CHOPPY/VOLATILE), lane alignment, experimental edge from track-record (no ML), Mark as taken → paper
- Stage 3.2: Analysis **50/50** layout — verdict left, live candlestick chart right (`AnalysisLiveChart` / `lightweight-charts`). Candles from `/api/analysis/candles` (prefer Yahoo timed OHLC so series matches live spot; Angel when available / non-demo). **Scalp chart TF pills: 3m / 5m / 15m** (`?tf=`); 3m via Yahoo 1m→3m aggregate when native 3m absent. Swing stays 1h. Forming bar patched from dashboard SSE LTP only when within **0.5%** of last close. Dashed Entry / SL / TP1 / TP2 price lines after synthesis. UI default mode **Scalp**.
- Chart tab (`/chart`, header + mobile nav): `ChartsPanel` shows **NIFTY + BANKNIFTY + SENSEX** live candlesticks together (3-up on xl, stacked on smaller). Shared Scalp/Swing mode; same `/api/analysis/candles` + dashboard SSE LTP path as Analysis.
- Stage 4: Scalp/Swing mode threaded through lanes + synthesizer + UI
- Stage 5: Paper trading models, P&L, expiry settlement cron, paper UI; paper account load hardened (DB retry + memory/file mirror); open positions show duration + premium TP/SL; auto-close on TP/SL hit → Closed table with status reason
- Stage 6: Time-ordered backtest cohorts + experimental track-record UI
- Stage 6.1: Backtest re-validation after 4-lane synthesis — `synthesisVersion` cohort split (legacy 2-lane-effective vs post-4-lane); edge badges use post-4-lane only with insufficient-sample gating; per-lane lean includes Macro + Sentiment
- Dashboard (default `/`): Binance-style paper portfolio P&L header (`PortfolioPnlCard` — est. total value, today’s PnL, gold equity sparkline, hide-balance toggle, client retry) above index quote cards for Nifty 50, Bank Nifty, Sensex, Gift Nifty + mini candles (`/api/dashboard`). **Live path:** backend `liveQuoteHub` + Angel SmartAPI WebSocket 2.0 (`websocketFeed.ts`) for Nifty / Bank Nifty / Sensex ticks (push on each tick via SSE `/api/dashboard/stream`); Gift Nifty still ~0.5s public feed (not on SmartAPI); full candle snapshot ~30s. Public NSE spots remain fallback if WS down. Browser `EventSource`. With `MARKETDATA_DEMO_MODE=true` / missing Angel keys, LTP is public-feed only. Pulsing **LIVE** badge + price flash when LTP changes. Index cards show IST session hours with open/closed styling (§7.1).
- Responsive app shell: mobile bottom tab nav + safe-area; desktop top nav + footer (see §7).
- Market session hours (`marketHours.ts`): IST open/closed for dashboard + macro quote ids; gold ● when open; ~30s UI tick; heuristic regular sessions only (no holiday calendar) — see §7.1.
- Dashboard macro strip (`/api/dashboard/macro`): Gift Nifty proxy, India VIX (NSE/Yahoo), US (Dow/Nasdaq/S&P), Asian indices, WTI/Brent crude, DXY, USDINR; this-week economic highlights (Fed/CPI/GDP/NFP/RBI when present); today’s news via Google/Yahoo RSS. Free unofficial APIs — no paid keys. News/events show heuristic **BULL / BEAR / MIXED** bias pills (keyword + print-vs-forecast; labeled experimental). Macro quotes auto-refresh ~15s (LIVE badge; pauses when tab hidden). Macro tiles reuse the same session-hours labels / open-state styling as index cards.
- Stage 6 track-record UI polish: `BacktestPanel` error state + retry; `ChartAiLoader` dedicated loading variant for track-record charts.
- Paper option chain: live NSE India OC for NIFTY/BANKNIFTY (Call/Put LTP + OI + % change) + SENSEX via Angel; **Angel SmartAPI WebSocket SnapQuote** for ATM ±10 CE/PE (`setOptionSubscriptions` on shared `websocketFeed`, `liveOptionChainHub`, SSE `/api/paper/chain/stream`); REST snapshot ~20s when WS live / ~2s fallback; spot marker from dashboard index SSE; Groww-style ATM divider.
- **Angel Option Greeks (Delta):** `src/lib/marketdata/optionGreeks.ts` → POST `/optionGreek` (TTL ~18s); merged by strike+optionType onto chain rows after NSE/Angel LTP/OI assembly (does not replace those sources). Paper chain shows compact **Δ** under CE/PE LTP (“Angel Greeks (approx.)”); off-hours/AB9019 → single “Greeks unavailable…” note, no per-row clutter. Mark as taken / scalp auto-paper use real delta for premium SL/TP when present; else 0.6/1.8 multiplier + **est. — no delta**.
- Analysis index drivers heatmap (`IndexDriversHeatmap` / `/api/analysis/heatmap`) — top-weight Nifty / Bank Nifty / Sensex names; **est. contribution pts** = `weight% × day% × indexLevel / 10000` (approx weights, not live NSE free-float); cell color = day %; sorted by |points|

### Not Yet
- Live Gift Nifty via SmartAPI (instrument absent from scrip master; dashboard uses free giftcitynifty.com NSE IX feed, with Nifty proxy fallback)
- Exchange holiday calendar for session open/closed (current `marketHours` is weekday + regular hours only)
- TimescaleDB hypertables for long-horizon IV / candle history (scalp candles use Postgres `MarketCandle` for now; IV trend still live + candle-derived proxy)
- Upstash Redis pub/sub for scalp second-level polling
- Multi-instance Redis fan-out for Angel option/index ticks (single-process in-memory hubs today); full-chain (non-ATM) WebSocket subscribe
- Real broker order placement (intentionally out of scope)

## External Data Sources

| Source | Used for | Cost | Rate limits / notes | Fallback |
|--------|----------|------|---------------------|----------|
| Angel One SmartAPI | Auth (TOTP), LTP, historical OHLCV (incl. scalp 1m/3m/5m/15m via `getCandleData`), market quote FULL (OI/IV), scrip master for option chain, **WebSocket 2.0** (`wss://smartapisocket.angelone.in/smart-stream`) — index Quote ticks (dashboard) + **NFO/BFO SnapQuote** for paper option-chain ATM ±10 strikes | Free tier (SmartAPI app) | Session valid until midnight; ≤3 concurrent WS per client; ~1000 tokens/session; heartbeat `ping` ~30s; historical max-days/request (1m=30, 3m=60, 5m=100, 15m=200) + ~500-row ceiling; REST throttle ~3–5 req/s; scalp MTF uses sequential gaps (`angelThrottle` + 350ms TF / 800ms underlying); retry/backoff on 5xx/429 | Typed `MarketDataUnavailableError`; WS down → public NSE spot / REST OC fallback; scalp candles → `MarketCandle` DB cache then empty/degraded; demo mock mode if credentials missing |
| Angel One Option Greeks API (`POST …/marketData/v1/optionGreek`) | Delta (display + SL/TP premium projection); Gamma/Theta/Vega/IV parsed but **not** surfaced in UI this stage. One call per underlying+expiry returns all strikes (`src/lib/marketdata/optionGreeks.ts`, TTL ~18s). Merged onto chain by strike+optionType after NSE/Angel LTP/OI | Free (SmartAPI) | Live contracts only; off-hours often AB9019 “No Data Available” (expected empty); Angel forum notes values may diverge from Sensibull etc. — labeled “Angel Greeks (approx.)”; docs historically NSE-focused (SENSEX/BFO best-effort, soft-fail) | Omit Δ from chain UI + single “Greeks unavailable outside market hours” note; paper SL/TP → static 0.6×/1.8× multiplier (`est. — no delta`); never throws to UI |
| OpenAPI Scrip Master JSON | Symbol tokens for NIFTY/BANKNIFTY/SENSEX options | Free public dump | Cache locally; refresh periodically | Cached file / demo strikes |
| Gift Nifty (NSE IFSC / NSE IX) | Dashboard + Macro lane Gift Nifty premium/discount cue | Free via `live.giftcitynifty.com/api/gift-nifty` | Soft limits; unofficial mirror of NSE IX; shared `getCachedMacroQuotes` TTL ~12s | Labeled Nifty 50 proxy if feed down; Macro lane omits Gift component |
| Yahoo Finance chart API | Dashboard LTP + 5m candles for ^NSEI / ^NSEBANK / ^BSESN; macro quotes (US/Asia indices, ^INDIAVIX, CL=F, BZ=F, DX-Y.NYB, INR=X) for dashboard strip **and** Macro lane scoring; **Analysis live chart** timed OHLC (`5m`/`60m` via `/api/analysis/candles` → `getPublicAnalysisCandles`); **Analysis index drivers heatmap** (constituent day % via `RELIANCE.NS` etc., TTL ~20s, batched) | Free unofficial | Soft rate limits; may 429; `/v7/quote` often Unauthorized — use `/v8/finance/chart`; analysis candles TTL ~20s; heatmap concurrency 4 | NSE `allIndices` spot for Nifty/Bank Nifty/India VIX; Macro lane score 0 + `"macro data unavailable"` if all feeds fail; analysis chart: Angel OHLC when non-demo, else 503; heatmap cells show — when quote miss |
| NSE India `allIndices` | Dashboard near-live LTP for Nifty / Bank Nifty / Sensex; India VIX spot (dashboard + Macro lane preferred VIX source); SSE forming-bar patch for analysis chart | Free public | Cookie/UA soft limits; ~1.5s in-process TTL coalesce | Yahoo chart; labeled demo; Macro lane omits VIX component if both fail |
| Forex Factory week JSON (`nfs.faireconomy.media`) | Dashboard economic calendar (Fed/CPI/GDP/NFP; RBI when listed) | Free unofficial mirror | Soft limits; INR/RBI coverage sparse | Empty buckets + UI note |
| Google News RSS + Yahoo Finance RSS | Dashboard “Today's News” + Sentiment lane headline bias aggregate | Free public RSS | Soft limits / regional variance; shared `getCachedMarketNews` TTL ~5m | Empty list + UI note; Sentiment omits news component and scores from FII/DII only |
| NSE India `fiidiiTradeReact` | Sentiment lane daily FII/DII cash net (₹ Cr) | Free public | Cookie/UA soft limits; provisional figures; shared TTL ~15m | Mr Chartist mirror; Sentiment omits FII/DII component if both fail |
| Mr Chartist FII/DII API (`fii-diidata.mrchartist.com/api/data`) | Sentiment lane FII/DII fallback (NSE-sourced mirror) | Free unofficial | Soft / polite limits; evening provisional | Sentiment news-only partial score if this and NSE both fail |
| NSE India `option-chain-v3` + `option-chain-contract-info` | Live option chain LTP / OI / IV / % change for NIFTY & BANKNIFTY | Free public | Cookie session + soft rate limits; SENSEX not on this API | Angel One quote FULL; then labeled demo mocks |
| Postgres (Supabase) via Prisma | Paper account, positions, trade ideas, backtest outcomes, **scalp `MarketCandle` OHLCV** (1m/3m/5m/15m) | Per Supabase plan | Pooler cold starts / network blips | In-memory + `.data/paper-account.json` mirror after successful read; file-only store if no `DATABASE_URL`; scalp fetch still works without DB (no persist / no DB-cache fallback) |
| Upstash Redis | Optional cache; future scalp pub/sub | Free tier limits apply | Per-plan | No-op client when env missing |

## Build order (reference)

0. Scaffold → 1. Angel One plumbing → 2. Technical + Options Flow → 2.5a Live Macro (done) → 2.5b Live Sentiment (done) → 3. Synthesis → 3.1 Trade plan UI → 3.2 Analysis live chart → 4. Scalp/Swing → 5. Paper → 6. Backtest → responsive shell + paper resilience
