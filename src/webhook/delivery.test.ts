import { createHmac } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    WORK_DIR: "", PORT: 0, WEBHOOK_ENABLED: true, ALERTS_CHANNEL_ID: "alerts",
    GITHUB_WEBHOOK_SECRET: "fixture", SENTRY_WEBHOOK_SECRET: "fixture", VERCEL_WEBHOOK_SECRET: "fixture",
    VAULT_SYNC_SECRET: "fixture",
  },
  channel: vi.fn(),
  send: vi.fn(),
  record: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchAlertsChannel: mocks.channel,
  fetchDeployLogChannel: mocks.channel,
  ownerMention: () => ({ content: "<@owner>" }),
}));
vi.mock("../agent/diagnose.js", () => ({ runAutoDiagnosis: vi.fn() }));
vi.mock("../stats/events.js", () => ({ recordEvent: mocks.record }));
vi.mock("../monitor/uptime.js", () => ({ probe: vi.fn() }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
vi.mock("../discord/client.js", async () => {
  const { Collection, Status } = await import("discord.js");
  return { getDiscordClient: () => ({ isReady: () => true, ws: { shards: new Collection([[0, { status: Status.Ready }]]) } }) };
});
vi.mock("../vault/state.js", () => ({}));
vi.mock("../digest/daily.js", () => ({}));
vi.mock("../jp/export.js", () => ({}));
vi.mock("./instagram-handler.js", () => ({}));
vi.mock("../monitor/status-board.js", () => ({}));

let root: string;
let queue: string;
let server: Server | undefined;
const projectName = "todari-ops";
interface Fixture {
  path: string;
  header: string;
  algo: string;
  prefix: string;
  headers: Record<string, string>;
  body: object;
}
const cases: Fixture[] = [
  {
    path: "github", header: "x-hub-signature-256", algo: "sha256", prefix: "sha256=",
    headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery-1" },
    body: { action: "opened", repository: { full_name: "Todari/todari-ops" }, pull_request: { number: 1, title: "Review me" } },
  },
  {
    path: "sentry/todari-ops", header: "sentry-hook-signature", algo: "sha256", prefix: "",
    headers: {},
    body: { action: "created", data: { issue: { id: "1", title: "Something broke" } } },
  },
  {
    path: "vercel", header: "x-vercel-signature", algo: "sha1", prefix: "",
    headers: {},
    body: { type: "deployment.error", payload: { name: projectName, deployment: { id: "dep1" } } },
  },
];

async function boot() {
  vi.resetModules();
  server = (await import("./server.js")).startWebhookServer();
  await once(server, "listening");
}
async function stop() {
  const active = server;
  if (!active) return;
  server = undefined;
  await new Promise<void>((resolve, reject) => active.close((err) => err ? reject(err) : resolve()));
}
function sendHook(fixture: Fixture, authenticated = true) {
  const body = JSON.stringify(fixture.body);
  const signature = createHmac(fixture.algo, "fixture").update(body).digest("hex");
  const port = (server?.address() as AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}/webhook/${fixture.path}`, {
    method: "POST", body,
    headers: {
      ...fixture.headers,
      [fixture.header]: authenticated ? fixture.prefix + signature : "invalid",
    },
  });
}
const state = () => JSON.parse(readFileSync(queue, "utf8")) as { pending: object; delivered: object };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "webhook-delivery-"));
  mocks.env.WORK_DIR = join(root, "work");
  queue = join(root, "webhook-alerts.json");
});
afterEach(async () => {
  await stop();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it.each(cases)("accepts $path only after saving and delivers once across restart and redelivery", async (fixture) => {
  await boot();
  expect((await sendHook(fixture, false)).status).toBe(401);
  expect(existsSync(queue)).toBe(false);
  mocks.channel.mockImplementationOnce(() => {
    expect(Object.values(state().pending)[0]).toMatchObject({ payload: fixture.body });
    return null;
  });
  expect((await sendHook(fixture)).status).toBe(200);
  expect(Object.keys(state().pending)).toHaveLength(1);
  expect(mocks.send).not.toHaveBeenCalled();
  await stop();

  mocks.channel.mockResolvedValue({ send: mocks.send });
  mocks.send.mockRejectedValueOnce(new Error("send rejected"));
  await boot();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(Object.keys(state().pending)).toHaveLength(1);
  await stop();

  mocks.send.mockResolvedValue(undefined);
  await boot();
  await vi.waitFor(() => expect(state().pending).toEqual({}));
  expect(mocks.send).toHaveBeenCalledTimes(2);
  const firstAttempt = mocks.send.mock.calls[0][0];
  expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({
    nonce: firstAttempt.nonce, enforceNonce: true,
  }));
  await stop();
  await boot();
  expect((await sendHook(fixture)).status).toBe(200);
  expect(state().pending).toEqual({});
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it("returns a retryable failure if a signed event cannot be written to disk", async () => {
  await boot();
  mkdirSync(queue + ".tmp");
  expect((await sendHook(cases[0])).status).toBe(500);
  expect(mocks.channel).not.toHaveBeenCalled();
  expect(existsSync(queue)).toBe(false);
});

it("sends a Vercel recovery after a restart when delivery of the failure already succeeded", async () => {
  mocks.channel.mockResolvedValue({ send: mocks.send });
  await boot();
  expect((await sendHook(cases[2])).status).toBe(200);
  await vi.waitFor(() => expect(state().pending).toEqual({}));
  await stop();

  await boot();
  const succeeded = { ...cases[2].body, type: "deployment.succeeded" };
  expect((await sendHook({ ...cases[2], body: succeeded })).status).toBe(200);
  await vi.waitFor(() => expect(state().pending).toEqual({}));
  expect(mocks.send.mock.calls[1][0].embeds[0].toJSON().title).toContain("복구됨");
});

it("retries Vercel recovery state persistence without re-posting an already sent alert", async () => {
  vi.resetModules();
  const { handleVercelEvent } = await import("./vercel-handler.js");
  const temp = join(root, "vercel-failures.json.tmp");
  mkdirSync(temp);
  mocks.channel.mockResolvedValue({ send: mocks.send });
  await expect(handleVercelEvent(cases[2].body, "test-nonce")).rejects.toThrow();
  expect(mocks.send).toHaveBeenCalledTimes(1);

  rmSync(temp, { recursive: true });
  await handleVercelEvent(cases[2].body, "test-nonce");
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(join(root, "vercel-failures.json"), "utf8"))).toEqual([projectName]);
});

it("keeps legacy pending action IDs usable and does not revive a consumed webhook action on retry", async () => {
  vi.resetModules();
  const { putPendingAction, getPendingAction, deletePendingAction } = await import("./pending.js");
  const action = { projectSlug: projectName, threadName: "review", prompt: "Review" };
  const legacy = putPendingAction(action);
  expect(legacy).toMatch(/^[a-f0-9]{8}$/);
  expect(getPendingAction(legacy)).toMatchObject(action);
  deletePendingAction(legacy);
  expect(getPendingAction(legacy)).toBeUndefined();

  const stable = "adbd138eb9b001fe37ca1d3a8";
  expect(putPendingAction(action, undefined, stable)).toBe(stable);
  expect(getPendingAction(stable)).toMatchObject(action);
  deletePendingAction(stable);
  putPendingAction(action, undefined, stable);
  expect(getPendingAction(stable)).toBeUndefined();
});

it("requires a signed Mac probe and publishes its receipt without changing bot health", async () => {
  await boot();
  const { runtimeHealth } = await import("../monitor/health.js");
  runtimeHealth.markInitialized();
  const health = () => fetch(`http://127.0.0.1:${(server?.address() as AddressInfo).port}/healthz`);
  const checkedAt = new Date().toISOString();
  const fixture = {
    path: "mac-monitor", header: "x-vault-signature", algo: "sha256", prefix: "", headers: {},
    body: { checkedAt, healthy: false },
  };
  expect((await sendHook(fixture, false)).status).toBe(401);
  expect(await (await health()).json()).toMatchObject({ ok: true, macProbe: { status: "unknown" } });
  expect((await sendHook(fixture)).status).toBe(200);
  const response = await health();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, macProbe: { status: "fresh", checkedAt, healthy: false } });
});
