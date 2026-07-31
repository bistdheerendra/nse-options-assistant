/**
 * Tiny in-process TTL cache for free public macro feeds.
 * Avoids hammering Yahoo / Forex Factory / RSS on every dashboard poll.
 * On loader failure, returns last good value if present (stale-while-error).
 */

type Entry<T> = { expiresAt: number; value: T };

const store = new Map<string, Entry<unknown>>();

export async function withTtlCache<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  try {
    const value = await loader();
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  } catch (err) {
    if (hit) return hit.value;
    throw err;
  }
}
