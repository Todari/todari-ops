import { describe, expect, it } from "vitest";
import { Client, Status, type WebSocketShard } from "discord.js";
import { isDiscordConnected, RuntimeHealth } from "./health.js";

describe("Discord gateway readiness", () => {
  it("rejects disconnected and reconnecting shards even if Client.isReady stays true", () => {
    const client = new Client({ intents: [] });
    client.ws.status = Status.Ready;
    expect(client.isReady()).toBe(true);
    expect(isDiscordConnected(client)).toBe(false);
    client.ws.shards.set(0, { status: Status.Ready } as WebSocketShard);
    expect(isDiscordConnected(client)).toBe(true);
    for (const status of [Status.Connecting, Status.Resuming, Status.Disconnected]) {
      client.ws.shards.set(1, { status } as WebSocketShard);
      expect(client.isReady()).toBe(true);
      expect(isDiscordConnected(client)).toBe(false);
    }
    client.ws.shards.set(1, { status: Status.Ready } as WebSocketShard);
    expect(isDiscordConnected(client)).toBe(true);
  });
});

describe("runtime health", () => {
  it("does not report ready before command and scheduler initialization", () => {
    const health = new RuntimeHealth();
    expect(health.snapshot(true).ok).toBe(false);
    expect(health.snapshot(true).checks.startup.status).toBe("starting");
    health.markInitialized();
    expect(health.snapshot(true).ok).toBe(true);
  });

  it("becomes unhealthy on Discord disconnect and recovers on reconnect", () => {
    const health = new RuntimeHealth();
    health.markInitialized();
    expect(health.snapshot(false)).toMatchObject({
      ok: false, checks: { discord: { status: "disconnected" } },
    });
    expect(health.snapshot(true).ok).toBe(true);
  });

  it("requires an enabled monitor to finish its first sweep", () => {
    const health = new RuntimeHealth();
    health.markInitialized();
    health.expectCheck("uptime", 300_000);
    expect(health.snapshot(true, 1_000)).toMatchObject({
      ok: false, checks: { uptime: { status: "starting", lastCompletedAt: null } },
    });
    health.completeCheck("uptime", 1_000);
    expect(health.snapshot(true, 1_000).ok).toBe(true);
  });

  it("detects a stopped monitor even while Discord and other monitors work", () => {
    const health = new RuntimeHealth();
    health.markInitialized();
    health.expectCheck("uptime", 300_000);
    health.expectCheck("resources", 300_000);
    health.completeCheck("uptime", 1_000);
    health.completeCheck("resources", 631_001);
    expect(health.snapshot(true, 631_000).ok).toBe(true);
    expect(health.snapshot(true, 631_001)).toMatchObject({
      ok: false,
      checks: { uptime: { status: "stale" }, resources: { status: "healthy" } },
    });
    health.completeCheck("uptime", 631_001);
    expect(health.snapshot(true, 631_001).ok).toBe(true);
  });

  it("does not require disabled monitors and rejects invalid intervals", () => {
    const health = new RuntimeHealth();
    health.markInitialized();
    expect(health.snapshot(true).checks).not.toHaveProperty("uptime");
    for (const interval of [0, -1, NaN, Infinity]) {
      expect(() => health.expectCheck("uptime", interval)).toThrow("Invalid monitoring interval");
    }
  });
});
