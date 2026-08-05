import { getUnderlyingCandles } from "../src/lib/marketdata/angelone";

async function main() {
  const c = await getUnderlyingCandles("NIFTY", "ONE_HOUR", 60);
  console.log("n", c.length);
  for (const i of [0, 1, 2, 3, c.length - 4, c.length - 3, c.length - 2, c.length - 1]) {
    const x = c[i];
    if (x) console.log(i, x.time, x.close);
  }
  const deltas: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const a = Date.parse(c[i - 1]!.time.replace(" ", "T") + "+05:30");
    const b = Date.parse(c[i]!.time.replace(" ", "T") + "+05:30");
    if (Number.isFinite(a) && Number.isFinite(b)) deltas.push((b - a) / 3_600_000);
  }
  const rounded = deltas.map((d) => Math.round(d * 10) / 10);
  const counts = new Map<number, number>();
  for (const d of rounded) counts.set(d, (counts.get(d) ?? 0) + 1);
  console.log(
    "delta hours histogram:",
    [...counts.entries()].sort((a, b) => a[0] - b[0]).slice(0, 30),
  );
}

main();
