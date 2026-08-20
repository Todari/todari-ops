import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { env } from "../env.js";
import { captureException } from "../observability/sentry.js";
import { verifyGithub, verifyInstagram, verifySentry, verifyVercel } from "./verify.js";
import { handleSentryEvent } from "./sentry-handler.js";
import { handleGithubEvent } from "./github-handler.js";
import { handleVercelEvent } from "./vercel-handler.js";
import { normalizeVaultState, saveVaultState } from "../vault/state.js";
import { updateDailyTopic } from "../digest/daily.js";
import { jpExport } from "../jp/export.js";
import { handleInstagramEvent, normalizeInstagramEvent } from "./instagram-handler.js";

const MAX_BODY_BYTES = 1_000_000;

export function startWebhookServer(): void {
  if (!env.ALERTS_CHANNEL_ID) {
    console.warn("[webhook] ALERTS_CHANNEL_ID missing — inbound alerts will be dropped");
  }
  for (const [name, secret] of [
    ["sentry", env.SENTRY_WEBHOOK_SECRET],
    ["github", env.GITHUB_WEBHOOK_SECRET],
    ["vercel", env.VERCEL_WEBHOOK_SECRET],
    ["vault-sync", env.VAULT_SYNC_SECRET],
    ["instagram", env.INSTAGRAM_WEBHOOK_SECRET],
  ] as const) {
    if (!secret) console.warn(`[webhook] ${name} secret missing — /webhook/${name} disabled`);
  }
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[webhook] unhandled:", err);
      captureException(err, { kind: "webhook-server" });
      writeJson(res, 500, { error: "internal" });
    });
  });
  server.listen(env.PORT, () => {
    console.log(`[webhook] listening on :${env.PORT}`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/healthz") {
    writeJson(res, 200, { ok: true });
    return;
  }

  const sentryMatch = method === "POST" && url.match(/^\/webhook\/sentry\/([a-zA-Z0-9-]+)$/);
  if (sentryMatch) {
    await handleSentryWebhook(sentryMatch[1], req, res);
    return;
  }
  if (method === "POST" && url === "/webhook/github") {
    await handleGithubWebhook(req, res);
    return;
  }
  if (method === "POST" && url === "/webhook/vercel") {
    await handleVercelWebhook(req, res);
    return;
  }
  if (method === "POST" && url === "/webhook/vault-sync") {
    await handleVaultSync(req, res);
    return;
  }
  if (method === "POST" && url === "/webhook/instagram") {
    await handleInstagramWebhook(req, res);
    return;
  }
  if (method === "POST" && url === "/jp/export") {
    await handleJpExport(req, res);
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

async function handleInstagramWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!env.INSTAGRAM_WEBHOOK_SECRET || !env.INSTAGRAM_CHANNEL_ID) {
    writeJson(res, 503, { error: "instagram webhook disabled" });
    return;
  }
  const body = await readBody(req);
  if (
    !verifyInstagram(
      body,
      headerValue(req, "x-instagram-signature"),
      env.INSTAGRAM_WEBHOOK_SECRET,
    )
  ) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  const payload = parseJson(body, res);
  if (payload === undefined) return;
  const event = normalizeInstagramEvent(payload);
  if (!event) {
    writeJson(res, 400, { error: "invalid shape" });
    return;
  }
  const delivered = await handleInstagramEvent(event);
  writeJson(res, 200, { ok: true, delivered });
}

// Mac-side cron (workspace-harness vault_sync.py) pushes extracted vault
// tasks/deadlines here. Same HMAC-SHA256-hex scheme as the Sentry hook.
async function handleVaultSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.VAULT_SYNC_SECRET) {
    writeJson(res, 503, { error: "vault sync disabled" });
    return;
  }
  const body = await readBody(req);
  if (!verifySentry(body, headerValue(req, "x-vault-signature"), env.VAULT_SYNC_SECRET)) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  const payload = parseJson(body, res);
  if (payload === undefined) return;
  const state = normalizeVaultState(payload);
  if (!state) {
    writeJson(res, 400, { error: "invalid shape" });
    return;
  }
  await saveVaultState(state);
  const tasks = state.notes.reduce((s, n) => s + n.tasks.length, 0);
  const deadlines = state.notes.reduce((s, n) => s + n.deadlines.length, 0);
  console.log(
    `[vault-sync] stored ${state.notes.length} notes, ${tasks} tasks, ${deadlines} deadlines (generatedAt ${state.generatedAt})`,
  );
  writeJson(res, 200, { ok: true, notes: state.notes.length, tasks, deadlines });
  void updateDailyTopic();
}

// Mac-side cron (workspace-harness jp_snapshot.py, Task 7b) pulls the
// learned-cards store to regenerate vault notes. Same HMAC scheme as
// vault-sync, reusing VAULT_SYNC_SECRET — no new secret needed.
async function handleJpExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.VAULT_SYNC_SECRET) {
    writeJson(res, 503, { error: "vault sync disabled" });
    return;
  }
  const body = await readBody(req);
  if (!verifySentry(body, headerValue(req, "x-vault-signature"), env.VAULT_SYNC_SECRET)) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  writeJson(res, 200, jpExport());
}

async function handleSentryWebhook(
  slug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!env.SENTRY_WEBHOOK_SECRET) {
    writeJson(res, 503, { error: "sentry webhook disabled" });
    return;
  }
  const body = await readBody(req);
  if (!verifySentry(body, headerValue(req, "sentry-hook-signature"), env.SENTRY_WEBHOOK_SECRET)) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  const payload = parseJson(body, res);
  if (payload === undefined) return;

  // Respond fast; do Discord post async so Sentry's 3s timeout never trips.
  writeJson(res, 200, { ok: true });
  void handleSentryEvent(slug, payload).catch((err) => {
    console.error("[webhook] sentry handler error:", err);
    captureException(err, { kind: "sentry-handler", slug });
  });
}

async function handleGithubWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    writeJson(res, 503, { error: "github webhook disabled" });
    return;
  }
  const body = await readBody(req);
  if (!verifyGithub(body, headerValue(req, "x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET)) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  const payload = parseJson(body, res);
  if (payload === undefined) return;
  const eventName = headerValue(req, "x-github-event") ?? "unknown";

  writeJson(res, 200, { ok: true });
  void handleGithubEvent(eventName, payload).catch((err) => {
    console.error("[webhook] github handler error:", err);
    captureException(err, { kind: "github-handler", eventName });
  });
}

async function handleVercelWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.VERCEL_WEBHOOK_SECRET) {
    writeJson(res, 503, { error: "vercel webhook disabled" });
    return;
  }
  const body = await readBody(req);
  if (!verifyVercel(body, headerValue(req, "x-vercel-signature"), env.VERCEL_WEBHOOK_SECRET)) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  const payload = parseJson(body, res);
  if (payload === undefined) return;

  writeJson(res, 200, { ok: true });
  void handleVercelEvent(payload).catch((err) => {
    console.error("[webhook] vercel handler error:", err);
    captureException(err, { kind: "vercel-handler" });
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Returns parsed JSON, or undefined after writing a 400 response. */
function parseJson(body: Buffer, res: ServerResponse): unknown | undefined {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    writeJson(res, 400, { error: "invalid json" });
    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
