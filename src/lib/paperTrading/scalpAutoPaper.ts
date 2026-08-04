import type { Underlying } from "@/lib/marketdata/angelone";
import { runSynthesis } from "@/lib/synthesis";
import {
  getOrCreateAccount,
  openPaperTrade,
  type PaperPosition,
} from "@/lib/paperTrading/account";
import { theoreticalMaxLossSell } from "@/lib/paperTrading/pnl";

/**
 * Auto paper-on-actionable scalp — paper only, never places broker orders.
 *
 * Gate (all must pass):
 *  1. mode SCALP synthesis
 *  2. scalpSignal.actionable === true  (confirm + liquidity + volume)
 *  3. structure.action BUY | SELL + suggestedContract
 *  4. no duplicate OPEN position (same underlying+strike+optionType+action)
 *  5. SELL requires acknowledgeSellRisk (caller / SCALP_AUTO_PAPER_ACK_SELL=true)
 */

export const SCALP_AUTO_UNDERLYINGS: Underlying[] = [
  "NIFTY",
  "BANKNIFTY",
  "SENSEX",
];

export type ScalpAutoPaperSkipReason =
  | "not_actionable"
  | "no_structure"
  | "no_contract"
  | "duplicate_open"
  | "sell_ack_required"
  | "synthesis_error";

export type ScalpAutoPaperItem = {
  underlying: Underlying;
  opened: boolean;
  skipped?: ScalpAutoPaperSkipReason;
  detail: string;
  positionId?: string;
  tradeIdeaId?: string | null;
  contract?: {
    strike: number;
    optionType: "CE" | "PE";
    action: "BUY" | "SELL";
    entryPremium: number;
  };
};

export type ScalpAutoPaperResult = {
  ok: true;
  paperOnly: true;
  ranAt: string;
  acknowledgeSellRisk: boolean;
  items: ScalpAutoPaperItem[];
  openedCount: number;
};

function hasDuplicateOpen(
  positions: PaperPosition[],
  candidate: {
    underlying: string;
    strike: number;
    optionType: string;
    action: string;
  },
): boolean {
  return positions.some(
    (p) =>
      p.status === "OPEN" &&
      p.mode === "SCALP" &&
      p.underlying === candidate.underlying &&
      p.strike === candidate.strike &&
      p.optionType === candidate.optionType &&
      p.action === candidate.action,
  );
}

function serverAllowsAutoSellAck(): boolean {
  return process.env.SCALP_AUTO_PAPER_ACK_SELL === "true";
}

/**
 * Run SCALP synthesis for each underlying and open paper when rule stack clears.
 */
export async function runScalpAutoPaper(opts?: {
  underlyings?: Underlying[];
  /** Client/UI sell-risk acknowledgement */
  acknowledgeSellRisk?: boolean;
}): Promise<ScalpAutoPaperResult> {
  const underlyings = opts?.underlyings?.length
    ? opts.underlyings
    : SCALP_AUTO_UNDERLYINGS;
  const acknowledgeSellRisk =
    Boolean(opts?.acknowledgeSellRisk) || serverAllowsAutoSellAck();

  const account = await getOrCreateAccount();
  const items: ScalpAutoPaperItem[] = [];

  for (const underlying of underlyings) {
    try {
      const syn = await runSynthesis({
        underlying,
        mode: "SCALP",
        persist: true,
      });

      if (!syn.scalpSignal?.actionable) {
        items.push({
          underlying,
          opened: false,
          skipped: "not_actionable",
          detail: syn.scalpSignal?.actionableNote ?? "Scalp signal not actionable",
          tradeIdeaId: syn.tradeIdeaId,
        });
        continue;
      }

      if (syn.structure.action !== "BUY" && syn.structure.action !== "SELL") {
        items.push({
          underlying,
          opened: false,
          skipped: "no_structure",
          detail: "Actionable scalp lean but structure branch is NONE/NEUTRAL",
          tradeIdeaId: syn.tradeIdeaId,
        });
        continue;
      }

      const c = syn.tradePlan.suggestedContract;
      if (!c) {
        items.push({
          underlying,
          opened: false,
          skipped: "no_contract",
          detail: "No suggested ATM contract for paper open",
          tradeIdeaId: syn.tradeIdeaId,
        });
        continue;
      }

      if (
        hasDuplicateOpen(account.positions, {
          underlying,
          strike: c.strike,
          optionType: c.optionType,
          action: syn.structure.action,
        })
      ) {
        items.push({
          underlying,
          opened: false,
          skipped: "duplicate_open",
          detail: `OPEN scalp already exists for ${c.strike} ${c.optionType} ${syn.structure.action}`,
          tradeIdeaId: syn.tradeIdeaId,
          contract: {
            strike: c.strike,
            optionType: c.optionType,
            action: syn.structure.action,
            entryPremium: c.entryPremium,
          },
        });
        continue;
      }

      if (syn.structure.action === "SELL" && !acknowledgeSellRisk) {
        items.push({
          underlying,
          opened: false,
          skipped: "sell_ack_required",
          detail:
            "Sell/write auto-paper blocked — set UI ack or SCALP_AUTO_PAPER_ACK_SELL=true",
          tradeIdeaId: syn.tradeIdeaId,
          contract: {
            strike: c.strike,
            optionType: c.optionType,
            action: "SELL",
            entryPremium: c.entryPremium,
          },
        });
        continue;
      }

      const risk = theoreticalMaxLossSell({
        action: syn.structure.action,
        optionType: c.optionType,
        strike: c.strike,
        entryPremium: c.entryPremium,
        lotSize: c.lotSize,
        lots: 1,
      });

      const updated = await openPaperTrade({
        underlying,
        strike: c.strike,
        optionType: c.optionType,
        expiry: c.expiry,
        action: syn.structure.action,
        lotSize: c.lotSize,
        lots: 1,
        entryPremium: c.entryPremium,
        mode: "SCALP",
        symbolToken: c.symboltoken,
        tradingSymbol: c.tradingsymbol,
        spotLevels:
          syn.tradePlan.stopLoss != null && syn.tradePlan.takeProfit1 != null
            ? {
                entrySpotAtSignal: syn.tradePlan.entry,
                stopLossSpot: syn.tradePlan.stopLoss,
                tp1Spot: syn.tradePlan.takeProfit1,
                tp2Spot: syn.tradePlan.takeProfit2,
                // Angel Greeks when available; null → 0.6/1.8 multiplier fallback
                delta: c.delta ?? null,
              }
            : null,
        entrySnapshot: {
          risk,
          autoPaper: true,
          tradeIdeaId: syn.tradeIdeaId,
          scalpSignal: {
            actionable: syn.scalpSignal.actionable,
            confirmation: syn.scalpSignal.confirmation.status,
            liquidity: syn.scalpSignal.liquidityStatus,
            volume: syn.scalpSignal.volumeConfirmation,
            pattern: syn.scalpSignal.primaryPattern,
            oi: syn.scalpSignal.oiVelocity.reading,
          },
          note: "Auto paper from actionable scalp — no broker order placed.",
        },
      });

      // Refresh local account snapshot for subsequent dedupe in this run
      account.positions = updated.positions;

      const opened = updated.positions
        .filter(
          (p) =>
            p.status === "OPEN" &&
            p.underlying === underlying &&
            p.strike === c.strike &&
            p.optionType === c.optionType &&
            p.action === syn.structure.action,
        )
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];

      items.push({
        underlying,
        opened: true,
        detail: `Paper ${syn.structure.action} ${c.optionType} ${c.strike} @ ₹${c.entryPremium} (auto)`,
        positionId: opened?.id,
        tradeIdeaId: syn.tradeIdeaId,
        contract: {
          strike: c.strike,
          optionType: c.optionType,
          action: syn.structure.action,
          entryPremium: c.entryPremium,
        },
      });
    } catch (err) {
      items.push({
        underlying,
        opened: false,
        skipped: "synthesis_error",
        detail: err instanceof Error ? err.message : "synthesis/auto-paper failed",
      });
    }
  }

  return {
    ok: true,
    paperOnly: true,
    ranAt: new Date().toISOString(),
    acknowledgeSellRisk,
    items,
    openedCount: items.filter((i) => i.opened).length,
  };
}
