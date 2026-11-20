import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import path from "node:path";
import { env } from "../env.js";
import { captureException } from "../observability/sentry.js";
import { verifyGithub, verifyInstagram, verifySentry, verifyVercel } from "./verify.js";
import { handleSentryEvent } from "./sentry-handler.js";
import { handleGithubEvent } from "./github-handler.js";
import { handleVercelEvent, vercelDelivery } from "./vercel-handler.js";
import { DeliveryQueue } from "../storage/delivery.js";
import { normalizeVaultState, saveVaultSnapshot } from "../vault/state.js";
import { updateDailyTopic } from "../digest/daily.js";
import { jpExport } from "../jp/export.js";
import {
  applyProblemResults,
  handleInstagramEvent,
  normalizeInstagramEvent,
  pendingProblemRequests,
} from "./instagram-handler.js";
import { getDiscordClient } from "../discord/client.js";
import { isDiscordConnected, runtimeHealth } from "../monitor/health.js";
import { macProbeHealth, receiveMacProbe } from "../monitor/mac-probe.js";
import { saveInstagramBrief, updateStatusBoard } from "../monitor/status-board.js";

const MAX_BODY_BYTES = 1_000_000;

type AlertEvent =
  | { source: "github"; eventName: string; payload: unknown }
  | { source: "sentry"; slug: string; payload: unknown }
  | { source: "vercel"; projectName: string; payload: unknown };

const alertDelivery = new DeliveryQueue<AlertEvent>(
  path.resolve(env.WORK_DIR, "..", "webhook-alerts.json"),
  (event, id) => {
    const nonce = id.slice(0, 25);
    switch (event.source) {
      case "github": return handleGithubEvent(event.eventName, event.payload, nonce);
      case "sentry": return handleSentryEvent(event.slug, event.payload, nonce);
      case "vercel": return handleVercelEvent(event.payload, nonce);
    }
    throw new Error("Unknown queued webhook source");
  },
  (event) => event?.source === "vercel" ? `vercel:${event.projectName}` : undefined,
);

// 인스타 워치독(EC2 크론 15분)이 실행마다 보내는 생존 신호의 점검 이름.
const WATCHDOG_CHECK = "instagram-watchdog";
const WATCHDOG_INTERVAL_MS = 15 * 60_000;

export function startWebhookServer(): ReturnType<typeof createServer> {
  if (env.INSTAGRAM_WEBHOOK_SECRET) {
    // 워치독이 멈추면 /healthz가 stale이 되어 외부 감시(.github/workflows/monitor.yml)가 알린다.
    // 재배포 직후 오탐을 막으려고 시작 시각을 첫 신호로 친다.
    runtimeHealth.expectCheck(WATCHDOG_CHECK, WATCHDOG_INTERVAL_MS);
    runtimeHealth.completeCheck(WATCHDOG_CHECK);
  }
  if (!env.WEBHOOK_ENABLED) {
    console.log("[webhook] inbound routes disabled; serving /healthz only");
  }
  if (env.WEBHOOK_ENABLED && !env.ALERTS_CHANNEL_ID) {
    console.warn("[webhook] ALERTS_CHANNEL_ID missing — inbound alerts will remain queued");
  }
  for (const [name, secret] of [
    ["sentry", env.SENTRY_WEBHOOK_SECRET],
    ["github", env.GITHUB_WEBHOOK_SECRET],
    ["vercel", env.VERCEL_WEBHOOK_SECRET],
    ["vault-sync", env.VAULT_SYNC_SECRET],
    ["instagram", env.INSTAGRAM_WEBHOOK_SECRET],
  ] as const) {
    if (env.WEBHOOK_ENABLED && !secret) console.warn(`[webhook] ${name} secret missing — /webhook/${name} disabled`);
  }
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[webhook] unhandled:", err);
      captureException(err, { kind: "webhook-server" });
      writeJson(res, 500, { error: "internal" });
    });
  });
  if (env.WEBHOOK_ENABLED) server.once("close", alertDelivery.start());
  server.listen(env.PORT, () => {
    console.log(`[webhook] listening on :${env.PORT}`);
  });
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/healthz") {
    const health = runtimeHealth.snapshot(isDiscordConnected(getDiscordClient()));
    writeJson(res, health.ok ? 200 : 503, { ...health, macProbe: macProbeHealth() });
    return;
  }

  if (!env.WEBHOOK_ENABLED) {
    writeJson(res, 503, { error: "webhooks disabled" });
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
  if (method === "POST" && url === "/webhook/mac-monitor") {
    await handleMacMonitor(req, res);
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
  const status = (payload as { status?: unknown } | null)?.status;
  if (status === "ops_poll") {
    // 워치독이 실행을 시작하며 알림 버튼 요청(다시 시도·건너뛰기)을 가져간다.
    writeJson(res, 200, { ok: true, commands: pendingProblemRequests() });
    return;
  }
  if (status === "heartbeat") {
    runtimeHealth.completeCheck(WATCHDOG_CHECK);
    // 생존 신호에 실려 온 인스타 현황으로 상태판을 고쳐 쓰고, 어제 실적은 아침 다이제스트용으로 둔다.
    // 실패해도 생존 신호는 받은 것이다.
    const { board, brief, ops_results } = payload as { board?: unknown; brief?: unknown; ops_results?: unknown };
    void applyProblemResults(ops_results).catch((err) => console.warn("[instagram] request results failed:", err));
    if (typeof brief === "string" && brief) saveInstagramBrief(brief.slice(0, 1000));
    void updateStatusBoard(typeof board === "string" && board ? board.slice(0, 1000) : null).catch(
      (err) => console.warn("[status] board update failed:", err),
    );
    writeJson(res, 200, { ok: true });
    return;
  }
  const event = normalizeInstagramEvent(payload);
  if (!event) {
    writeJson(res, 400, { error: "invalid shape" });
    return;
  }
  const delivered = await handleInstagramEvent(event);
  writeJson(res, 200, { ok: true, delivered });
}

async function handleMacMonitor(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.VAULT_SYNC_SECRET) {
    writeJson(res, 503, { error: "Mac monitor disabled" });
    return;
  }
  const body = await readBody(req);
  if (!verifySentry(body, headerValue(req, "x-vault-signature"), env.VAULT_SYNC_SECRET)) {
    writeJson(res, 401, { error: "invalid signature" });
    return;
  }
  const payload = parseJson(body, res);
  if (payload === undefined) return;
  if (!receiveMacProbe(payload)) {
    writeJson(res, 400, { error: "invalid probe" });
    return;
  }
  writeJson(res, 200, { ok: true });
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
  const result = await saveVaultSnapshot(state);
  if (result !== "stored") {
    writeJson(res, 409, { error: result });
    return;
  }
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

  acceptAlert(res, { source: "sentry", slug, payload }, slug, body);
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

  if (eventName === "pull_request" || eventName === "workflow_run") {
    acceptAlert(res, { source: "github", eventName, payload }, eventName, headerValue(req, "x-github-delivery") || body);
    return;
  }
  if (eventName === "ping") await handleGithubEvent(eventName, payload, "");
  writeJson(res, 200, { ok: true });
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

  const deployment = vercelDelivery(payload);
  if (deployment) {
    acceptAlert(res, { source: "vercel", projectName: deployment.projectName, payload }, deployment.type, deployment.deploymentId || body);
    return;
  }
  writeJson(res, 200, { ok: true });
}

function acceptAlert(res: ServerResponse, event: AlertEvent, scope: string, identity: string | Buffer): void {
  const id = createHash("sha256").update(JSON.stringify([event.source, scope])).update(identity).digest("hex");
  alertDelivery.enqueue(id, event);
  writeJson(res, 200, { ok: true });
  void alertDelivery.retry();
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
