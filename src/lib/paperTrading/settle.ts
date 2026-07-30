import { getUnderlyingLtp, type Underlying } from "@/lib/marketdata/angelone";
import { settleExpiredPositions } from "./account";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

/** Idempotent expiry settlement — safe to cron repeatedly. */
export async function runExpirySettlement() {
  const spotByUnderlying: Record<string, number> = {};
  for (const u of UNDERLYINGS) {
    try {
      const q = await getUnderlyingLtp(u);
      spotByUnderlying[u] = q.ltp;
    } catch {
      // Skip underlyings we cannot mark — do not settle those rows this run
    }
  }
  return settleExpiredPositions(spotByUnderlying);
}
