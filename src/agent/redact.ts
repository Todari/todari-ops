const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|private[_-]?key|secret|token|api[_-]?key)/i;

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactValue(child, seen);
  }
  return redacted;
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(/x-access-token:[^@\s]+@/gi, "[REDACTED]@")
    .replace(
      /\b(?:github_pat_|gh[pousr]_|sk-ant-|sk-proj-|xox[baprs]-)[A-Za-z0-9_-]+/gi,
      "[REDACTED]",
    )
    .replace(
      /([?&](?:access_?token|api_?key|password|secret|token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}
