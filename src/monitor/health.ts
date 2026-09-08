import { Status, type Client } from "discord.js";

// Client.isReady() can remain true while individual gateway shards reconnect.
export function isDiscordConnected(client: Pick<Client, "isReady" | "ws">): boolean {
  return client.isReady() && client.ws.shards.size > 0 &&
    client.ws.shards.every((shard) => shard.status === Status.Ready);
}

interface ScheduledCheck {
  maxAgeMs: number;
  lastCompletedAt: number | null;
}

export interface HealthSnapshot {
  ok: boolean;
  checks: Record<string, {
    status: "healthy" | "starting" | "disconnected" | "stale";
    lastCompletedAt?: string | null;
  }>;
}

// A failed service probe still counts as a completed monitoring cycle. This
// endpoint describes the bot's ability to operate, not the health of its targets.
export class RuntimeHealth {
  private initialized = false;
  private scheduled = new Map<string, ScheduledCheck>();

  markInitialized(): void {
    this.initialized = true;
  }

  expectCheck(name: string, intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`Invalid monitoring interval for ${name}`);
    }
    this.scheduled.set(name, {
      maxAgeMs: intervalMs * 2 + 30_000,
      lastCompletedAt: null,
    });
  }

  completeCheck(name: string, now = Date.now()): void {
    const check = this.scheduled.get(name);
    if (check) check.lastCompletedAt = now;
  }

  snapshot(discordReady: boolean, now = Date.now()): HealthSnapshot {
    const checks: HealthSnapshot["checks"] = {
      startup: { status: this.initialized ? "healthy" : "starting" },
      discord: { status: discordReady ? "healthy" : "disconnected" },
    };
    for (const [name, check] of this.scheduled) {
      checks[name] = {
        status: check.lastCompletedAt === null
          ? "starting"
          : now - check.lastCompletedAt > check.maxAgeMs ? "stale" : "healthy",
        lastCompletedAt: check.lastCompletedAt === null
          ? null
          : new Date(check.lastCompletedAt).toISOString(),
      };
    }
    return { ok: Object.values(checks).every((check) => check.status === "healthy"), checks };
  }
}

export const runtimeHealth = new RuntimeHealth();
