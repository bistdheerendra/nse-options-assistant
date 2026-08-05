import { Redis } from "@upstash/redis";
import fs from "node:fs";
import path from "node:path";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Upstash Redis singleton (REST). When env is missing, methods no-op so local/demo works.
 * Caching only — REST has no pub/sub. Scalp candle push uses in-process scalpCandleHub + SSE.
 */
export const redis: Redis | null =
  url && token ? new Redis({ url, token }) : null;

/** Cross-process local fallback so poll:scalp-candles → soft-watch works without Upstash. */
const FILE_CACHE_PATH = path.join(process.cwd(), ".data", "shared-cache.json");

type FileEntry = { value: unknown; expiresAt: number | null };

function readFileStore(): Record<string, FileEntry> {
  try {
    if (!fs.existsSync(FILE_CACHE_PATH)) return {};
    const raw = fs.readFileSync(FILE_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, FileEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeFileStore(store: Record<string, FileEntry>): void {
  const dir = path.dirname(FILE_CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${FILE_CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
  fs.renameSync(tmp, FILE_CACHE_PATH);
}

function fileCacheGet<T>(key: string): T | null {
  const store = readFileStore();
  const entry = store[key];
  if (!entry) return null;
  if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
    delete store[key];
    writeFileStore(store);
    return null;
  }
  return (entry.value as T) ?? null;
}

function fileCacheSet(key: string, value: unknown, ttlSeconds: number): void {
  const store = readFileStore();
  store[key] = {
    value,
    expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
  };
  writeFileStore(store);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (redis) {
    try {
      return (await redis.get<T>(key)) ?? null;
    } catch {
      return null;
    }
  }
  try {
    return fileCacheGet<T>(key);
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = 30,
): Promise<void> {
  if (redis) {
    try {
      await redis.set(key, value, { ex: ttlSeconds });
    } catch {
      // degrade silently — cache is optional
    }
    return;
  }
  try {
    fileCacheSet(key, value, ttlSeconds);
  } catch {
    // degrade silently — cache is optional
  }
}
