import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { projects, type ProjectConfig } from "../projects.js";
import { fetchAlertsChannel } from "../discord/alerts.js";
import { captureException } from "../observability/sentry.js";
import { recordEvent } from "../stats/events.js";

// Polls every project with a healthUrl. Two consecutive failures → down alert
// (once), first success afterwards → recovery alert with downtime duration.
const FAIL_THRESHOLD = 2;
const PROBE_TIMEOUT_MS = 10_000;

interface TargetState {
  up: boolean;
  failCount: number;
  downSince: number | null;
  lastDetail: string;
  lastCheckedAt: number;
}

const states = new Map<string, TargetState>();
let started = false;

// down 상태를 볼륨에 영속화 — 재시작·재배포마다 죽어있는 사이트를 새로
// 알리는 스팸을 막는다 (failCount 는 휘발이어도 무방).
const STATE_FILE = path.resolve(env.WORK_DIR, "..", "uptime-state.json");

function loadPersistedStates(): void {
  try {
    if (!existsSync(STATE_FILE)) return;
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<
      string,
      { up: boolean; downSince: number | null }
    >;
    for (const [slug, s] of Object.entries(raw)) {
      states.set(slug, {
        up: s.up,
        failCount: s.up ? 0 : FAIL_THRESHOLD,
        downSince: s.downSince,
        lastDetail: "(재시작 전 상태 복원)",
        lastCheckedAt: 0,
      });
    }
    const down = [...states.values()].filter((s) => !s.up).length;
    if (states.size > 0) console.log(`[uptime] restored ${states.size} states (${down} down)`);
  } catch (err) {
    console.warn("[uptime] state restore failed:", err);
  }
}

async function persistStates(): Promise<void> {
  try {
    const out: Record<string, { up: boolean; downSince: number | null }> = {};
    for (const [slug, s] of states) out[slug] = { up: s.up, downSince: s.downSince };
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(out, null, 2));
    await rename(tmp, STATE_FILE);
  } catch (err) {
    console.warn("[uptime] state persist failed:", err);
  }
}

export function startUptimeMonitor(): void {
  if (started) return;
  const targets = projects.filter((p): p is ProjectConfig & { healthUrl: string } =>
    Boolean(p.healthUrl),
  );
  if (!env.UPTIME_ENABLED || targets.length === 0 || !env.ALERTS_CHANNEL_ID) {
    console.log("[uptime] disabled (UPTIME_ENABLED=false, no targets, or no ALERTS_CHANNEL_ID)");
    return;
  }
  started = true;
  loadPersistedStates();
  console.log(
    `[uptime] monitoring ${targets.length} targets every ${Math.round(env.UPTIME_INTERVAL_MS / 1000)}s`,
  );
  void sweep(targets);
  setInterval(() => void sweep(targets), env.UPTIME_INTERVAL_MS);
}

export interface UptimeSnapshotEntry {
  slug: string;
  name: string;
  url: string;
  up: boolean;
  detail: string;
}

export function getUptimeSnapshot(): UptimeSnapshotEntry[] {
  return projects
    .filter((p) => p.healthUrl)
    .map((p) => {
      const st = states.get(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        url: p.healthUrl!,
        up: st?.up ?? true,
        detail: st?.lastDetail ?? "(아직 체크 전)",
      };
    });
}

async function sweep(targets: Array<ProjectConfig & { healthUrl: string }>): Promise<void> {
  await Promise.allSettled(targets.map((t) => check(t)));
}

async function check(p: ProjectConfig & { healthUrl: string }): Promise<void> {
  const result = await probe(p.healthUrl);
  const st = states.get(p.slug) ?? {
    up: true,
    failCount: 0,
    downSince: null,
    lastDetail: "",
    lastCheckedAt: 0,
  };
  st.lastDetail = result.detail;
  st.lastCheckedAt = Date.now();

  if (result.ok) {
    if (!st.up) {
      const downFor = st.downSince ? formatDuration(Date.now() - st.downSince) : "?";
      st.up = true;
      st.downSince = null;
      recordEvent("uptime_recover", p.slug);
      void persistStates();
      await postAlert(
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle(`🟢 [${p.name}] 복구됨`)
          .setDescription(`${p.healthUrl} — ${result.detail}\n다운타임: ${downFor}`),
      );
    }
    st.failCount = 0;
  } else {
    st.failCount += 1;
    if (st.up && st.failCount >= FAIL_THRESHOLD) {
      st.up = false;
      st.downSince = Date.now();
      recordEvent("uptime_down", p.slug);
      void persistStates();
      await postAlert(
        new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle(`🔴 [${p.name}] DOWN`)
          .setDescription(
            `${p.healthUrl} — ${result.detail}\n(${FAIL_THRESHOLD}회 연속 실패, 복구 시 다시 알림)`,
          ),
      );
    }
  }
  states.set(p.slug, st);
}

export async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "User-Agent": "todari-ops-uptime/1.0" },
    });
    return { ok: res.status < 400, detail: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return { ok: false, detail: msg };
  }
}

async function postAlert(embed: EmbedBuilder): Promise<void> {
  try {
    const channel = await fetchAlertsChannel();
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("[uptime] alert post failed:", err);
    captureException(err, { kind: "uptime-alert" });
  }
}

function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "1분 미만";
  if (min < 60) return `${min}분`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 ${min % 60}분`;
  return `${Math.floor(hr / 24)}일 ${hr % 24}시간`;
}
