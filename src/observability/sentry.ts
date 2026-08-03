// Side-effect import: initializes Sentry at module load if SENTRY_DSN is set.
// Import this BEFORE anything that might throw at boot.
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
const enabled = Boolean(dsn);

if (enabled) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  console.log("[sentry] initialized");
} else {
  console.log("[sentry] no SENTRY_DSN — error tracking disabled");
}

export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
