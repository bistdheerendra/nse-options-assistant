/**
 * Quick Angel WS smoke test — connects, waits for ticks, exits.
 * Usage: npx tsx scripts/test-angel-ws.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  angelWebsocketFeed,
  parseAngelQuotePacket,
} from "../src/lib/marketdata/angelone/websocketFeed";

// Load .env without dotenv dependency
try {
  const envPath = resolve(process.cwd(), ".env");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.warn("No .env loaded");
}

const fake = Buffer.alloc(123);
fake.writeInt8(2, 0);
fake.writeInt8(1, 1);
Buffer.from("99926000").copy(fake, 2);
fake.writeBigInt64LE(BigInt(0), 27);
fake.writeBigInt64LE(BigInt(Date.now()), 35);
fake.writeBigInt64LE(BigInt(2438360), 43);
fake.writeBigInt64LE(BigInt(2431715), 115);
const parsed = parseAngelQuotePacket(fake);
console.log("parse_ok", parsed?.underlying, parsed?.ltp, parsed?.prevClose);

const release = angelWebsocketFeed.acquire();
const unsub = angelWebsocketFeed.onTick((t) => {
  console.log(
    "tick",
    t.underlying,
    t.ltp,
    new Date(t.exchangeTs).toISOString(),
  );
});
angelWebsocketFeed.onStatus((s) => console.log("status", s));

setTimeout(() => {
  console.log("latest", angelWebsocketFeed.getLatestTicks());
  console.log("final_status", angelWebsocketFeed.getStatus());
  unsub();
  release();
  process.exit(0);
}, 12_000);
