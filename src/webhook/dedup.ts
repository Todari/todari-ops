// Collapse related alerts for five minutes after a successful Discord post.

const seen = new Map<string, number>();
const TTL_MS = 5 * 60 * 1000;

export function wasDelivered(fingerprint: string, now = Date.now()): boolean {
  pruneExpired(now);
  return seen.has(fingerprint);
}

export function markDelivered(fingerprint: string, now = Date.now()): void {
  seen.set(fingerprint, now);
}

function pruneExpired(now: number): void {
  for (const [key, ts] of seen) {
    if (now - ts >= TTL_MS) seen.delete(key);
  }
}
