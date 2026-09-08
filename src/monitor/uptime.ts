import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { getHealthTargets, type HealthTarget, type ProjectHealthCheck } from "../projects.js";
import { fetchAlertsChannel } from "../discord/alerts.js";
import { captureException } from "../observability/sentry.js";
import { recordEvent } from "../stats/events.js";
import { runtimeHealth } from "./health.js";

// Polls each configured health target. Two consecutive failures → down alert
// (once), first success afterwards → recovery alert with downtime duration.
const FAIL_THRESHOLD = 2;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 16_384;

interface TargetState {
  up: boolean;
  failCount: number;
  downSince: number | null;
  lastDetail: string;
  lastCheckedAt: number | null;
  lastOutcome: "success" | "failure" | null;
}

const states = new Map<string, TargetState>();
let started = false;
let sweepRunning = false;
let stateWrites = Promise.resolve();

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
        lastCheckedAt: null,
        lastOutcome: null,
      });
    }
    const down = [...states.values()].filter((s) => !s.up).length;
    if (states.size > 0) console.log(`[uptime] restored ${states.size} states (${down} down)`);
  } catch (err) {
    console.warn("[uptime] state restore failed:", err);
  }
}

function persistStates(): Promise<void> {
  // All targets share the same temporary file. Serialize writes so one target
  // cannot rename another target's in-flight write or overwrite a newer state.
  stateWrites = stateWrites.then(async () => {
    const out: Record<string, { up: boolean; downSince: number | null }> = {};
    for (const [slug, s] of states) out[slug] = { up: s.up, downSince: s.downSince };
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(out, null, 2));
    await rename(tmp, STATE_FILE);
  }).catch((err) => {
    console.warn("[uptime] state persist failed:", err);
  });
  return stateWrites;
}

export function startUptimeMonitor(): void {
  if (started) return;
  const targets = getHealthTargets();
  if (!env.UPTIME_ENABLED || targets.length === 0 || !env.ALERTS_CHANNEL_ID) {
    console.log("[uptime] disabled (UPTIME_ENABLED=false, no targets, or no ALERTS_CHANNEL_ID)");
    return;
  }
  started = true;
  runtimeHealth.expectCheck("uptime", env.UPTIME_INTERVAL_MS);
  loadPersistedStates();
  console.log(
    `[uptime] monitoring ${targets.length} targets every ${Math.round(env.UPTIME_INTERVAL_MS / 1000)}s`,
  );
  void sweep(targets);
  setInterval(() => void sweep(targets), env.UPTIME_INTERVAL_MS);
}

export type UptimeStatus = "healthy" | "down" | "unknown" | "stale";

export interface UptimeSnapshotEntry {
  key: string;
  slug: string;
  name: string;
  checkName: string | null;
  url: string;
  status: UptimeStatus;
  lastCheckedAt: number | null;
  lastOutcome: "success" | "failure" | null;
  detail: string;
}

const STATUS_ORDER: Record<UptimeStatus, number> = { down: 0, stale: 1, unknown: 2, healthy: 3 };

export function getUptimeSnapshot(now = Date.now()): UptimeSnapshotEntry[] {
  return getHealthTargets()
    .map((p): UptimeSnapshotEntry => {
      const st = states.get(p.key);
      let status: UptimeStatus = "unknown";
      let detail = "아직 검사 전";
      if (!env.UPTIME_ENABLED) detail = "감시 비활성화";
      else if (!env.ALERTS_CHANNEL_ID) detail = "알림 채널 미설정으로 감시 비활성화";
      else if (!started) detail = "감시 시작 전";
      else if (st && st.lastCheckedAt === null) detail = "재시작 후 재검사 대기";
      else if (st?.lastCheckedAt != null && st.lastOutcome !== null) {
        detail = st.lastDetail;
        if (now - st.lastCheckedAt > env.UPTIME_INTERVAL_MS * 2 + 30_000) {
          status = "stale";
          detail = `마지막 ${st.lastOutcome === "success" ? "정상" : "실패"}: ${detail}`;
        } else if (st.lastOutcome === "success") status = "healthy";
        else if (!st.up) status = "down";
        else detail = `${st.failCount}회 실패, 재확인 대기: ${detail}`;
      }
      return {
        key: p.key,
        slug: p.slug,
        name: p.name,
        checkName: p.checkName,
        url: p.url,
        status,
        lastCheckedAt: st?.lastCheckedAt ?? null,
        lastOutcome: st?.lastOutcome ?? null,
        detail,
      };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

/** Shared by the daily digest, natural-language status, and /status embeds. */
export function formatUptimeSnapshot(
  entries: UptimeSnapshotEntry[], now = Date.now(), maxLength = 1000,
): string {
  const labels: Record<UptimeStatus, string> = {
    healthy: "🟢 정상", down: "🔴 장애", unknown: "⚪ 미확인", stale: "🟡 오래됨",
  };
  const sorted = [...entries].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const lines: string[] = [];
  for (const entry of sorted) {
    const checked = entry.lastCheckedAt === null
      ? "최근 검사시각 없음"
      : `검사 ${formatDuration(Math.max(0, now - entry.lastCheckedAt))} 전`;
    const detail = entry.detail.replace(/\s+/g, " ").slice(0, 100);
    const target = entry.checkName ? `${entry.slug}/${entry.checkName}` : entry.slug;
    const line = `${labels[entry.status]} · ${target} · ${detail} · ${checked}`;
    const remaining = sorted.length - lines.length - 1;
    const suffix = remaining > 0 ? `\n… 외 ${remaining}개` : "";
    if ([...lines, line].join("\n").length + suffix.length > maxLength) break;
    lines.push(line);
  }
  if (lines.length < sorted.length) lines.push(`… 외 ${sorted.length - lines.length}개`);
  return lines.join("\n").slice(0, maxLength);
}

async function sweep(targets: HealthTarget[]): Promise<void> {
  // A stalled probe/alert must not overlap a later sweep and overwrite its result.
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await Promise.allSettled(targets.map((t) => check(t)));
    runtimeHealth.completeCheck("uptime");
  } finally {
    sweepRunning = false;
  }
}

async function check(p: HealthTarget): Promise<void> {
  const result = await probe(p.url, p.expectJson);
  const st = states.get(p.key) ?? {
    up: true,
    failCount: 0,
    downSince: null,
    lastDetail: "",
    lastCheckedAt: null,
    lastOutcome: null,
  };
  st.lastDetail = result.detail;
  st.lastCheckedAt = Date.now();
  st.lastOutcome = result.ok ? "success" : "failure";
  let alert: EmbedBuilder | null = null;
  let event: "uptime_recover" | "uptime_down" | null = null;
  const targetName = p.checkName ? `${p.name}/${p.checkName}` : p.name;

  if (result.ok) {
    if (!st.up) {
      const downFor = st.downSince ? formatDuration(Date.now() - st.downSince) : "?";
      st.up = true;
      st.downSince = null;
      event = "uptime_recover";
      alert = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle(`🟢 [${targetName}] 복구됨`)
          .setDescription(`${p.url} — ${result.detail}\n다운타임: ${downFor}`);
    }
    st.failCount = 0;
  } else {
    st.failCount += 1;
    if (st.up && st.failCount >= FAIL_THRESHOLD) {
      st.up = false;
      st.downSince = Date.now();
      event = "uptime_down";
      alert = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle(`🔴 [${targetName}] DOWN`)
          .setDescription(
            `${p.url} — ${result.detail}\n(${FAIL_THRESHOLD}회 연속 실패, 복구 시 다시 알림)`,
          );
    }
  }
  states.set(p.key, st);
  if (event) {
    recordEvent(event, p.slug);
    await persistStates();
  }
  if (alert) await postAlert(alert);
}

export async function probe(
  url: string, expectJson?: ProjectHealthCheck["expectJson"],
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "User-Agent": "todari-ops-uptime/1.0" },
    });
    const detail = `HTTP ${res.status}`;
    if (res.status >= 400 || !expectJson) {
      void res.body?.cancel().catch(() => {});
      return { ok: res.status < 400, detail };
    }
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, detail: `${detail} · JSON 응답 없음` };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JSON_BYTES) return { ok: false, detail: `${detail} · JSON 크기 제한 초과` };
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return { ok: false, detail: `${detail} · JSON 형식 오류` };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, detail: `${detail} · JSON 객체 아님` };
    }
    const mismatches = Object.entries(expectJson).filter(
      ([key, expected]) => !Object.hasOwn(data, key) || (data as Record<string, unknown>)[key] !== expected,
    ).map(([key]) => key);
    return mismatches.length > 0
      ? { ok: false, detail: `${detail} · 정상 조건 불일치: ${mismatches.join(", ")}` }
      : { ok: true, detail: `${detail} · JSON 정상` };
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
