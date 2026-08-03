import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactSensitive } from "../agent/redact.js";
import { env } from "../env.js";

export interface AuditEntry {
  threadId: string;
  tool: string;
  input: unknown;
  decision: string;
  reason?: string;
}

// Sit alongside WORK_DIR's parent so the audit log lives on the mounted
// volume (`/data/audit.log` in prod, `./data/audit.log` in dev) instead of
// the container WORKDIR which is wiped on every recreate.
const AUDIT_PATH = path.resolve(path.dirname(env.WORK_DIR), "audit.log");
let dirEnsured = false;

export async function logAudit(entry: AuditEntry): Promise<void> {
  if (!dirEnsured) {
    await mkdir(path.dirname(AUDIT_PATH), { recursive: true });
    dirEnsured = true;
  }
  const ts = new Date().toISOString();
  const truncatedInput = truncate(redactSensitive(entry.input));
  const line = JSON.stringify({ ts, ...entry, input: truncatedInput });
  await appendFile(AUDIT_PATH, line + "\n", "utf8");
}

function truncate(v: unknown): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s && s.length > 2000) return s.slice(0, 2000) + "…(trunc)";
  return v;
}
