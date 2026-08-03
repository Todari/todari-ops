// Tiny in-memory dedup: same fingerprint within TTL → drop. v1.
// Stage 3 will move this to Postgres if alert volume grows.

const seen = new Map<string, number>();
const TTL_MS = 5 * 60 * 1000;

export function shouldDrop(fingerprint: string, now = Date.now()): boolean {
  pruneExpired(now);
  const last = seen.get(fingerprint);
  if (last !== undefined && now - last < TTL_MS) return true;
  seen.set(fingerprint, now);
  return false;
}

function pruneExpired(now: number): void {
  for (const [key, ts] of seen) {
    if (now - ts >= TTL_MS) seen.delete(key);
  }
}
