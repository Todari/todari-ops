import { EmbedBuilder } from "discord.js";
import { readFile, statfs } from "node:fs/promises";
import { env } from "../env.js";
import { fetchAlertsChannel } from "../discord/alerts.js";
import { captureException } from "../observability/sentry.js";

// 호스트 리소스 워치독. 봇은 이 EC2 위에서 도는데, 박스가 메모리 고갈로 죽으면
// 봇도 같이 죽어 알림을 못 낸다(2026-07-27 OOM 사고). 그래서 죽기 "전에" —
// 메모리/스왑이 임계에 다다르면 — #alerts로 경고한다. Docker 컨테이너 안에서도
// /proc/meminfo는 호스트 메모리를 반영하므로 값이 정확하다.

export interface MemInfo {
  memTotal: number; // kB
  memAvailable: number;
  swapTotal: number;
  swapFree: number;
}

export function parseMemInfo(text: string): MemInfo {
  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : 0;
  };
  return {
    memTotal: get("MemTotal"),
    memAvailable: get("MemAvailable"),
    swapTotal: get("SwapTotal"),
    swapFree: get("SwapFree"),
  };
}

export function memUsage(m: MemInfo): number {
  return m.memTotal > 0 ? (m.memTotal - m.memAvailable) / m.memTotal : 0;
}

export function swapUsage(m: MemInfo): number {
  return m.swapTotal > 0 ? (m.swapTotal - m.swapFree) / m.swapTotal : 0;
}

// 히스테리시스: 경고 임계에서 켜지고, 회복 임계 아래로 내려가야 꺼진다(플래핑 방지).
const MEM_HI = 0.9;
const MEM_LO = 0.85;
const SWAP_HI = 0.6;
const SWAP_LO = 0.45;
const DISK_HI = 0.9;
const DISK_LO = 0.82;

let memAlerted = false;
let swapAlerted = false;
let diskAlerted = false;

// 컨테이너의 /는 오버레이라 호스트 디스크를 반영하지 않는다. 볼륨으로 마운트된
// WORK_DIR(/data)은 호스트 루트 파일시스템 위에 있으므로 그 경로로 측정한다.
const DISK_PROBE_PATH = process.env.WORK_DIR ?? "/data";

// df와 같은 계산: 루트 예약 블록을 제외한 가용(bavail) 기준 사용률.
export function diskUsage(blocks: number, bfree: number, bavail: number): number {
  const used = blocks - bfree;
  const denominator = used + bavail;
  return denominator > 0 ? used / denominator : 0;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const gb = (kb: number) => `${(kb / 1024 / 1024).toFixed(1)}GB`;

async function send(title: string, desc: string, color: number): Promise<void> {
  try {
    const channel = await fetchAlertsChannel();
    if (channel) {
      await channel.send({
        embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)],
      });
    }
  } catch (err) {
    captureException(err, { kind: "resource-alert" });
  }
}

async function check(): Promise<void> {
  let text: string;
  try {
    text = await readFile("/proc/meminfo", "utf8");
  } catch (err) {
    captureException(err, { kind: "resource-read" });
    return;
  }
  const m = parseMemInfo(text);
  if (m.memTotal <= 0) return;
  const mem = memUsage(m);
  const swap = swapUsage(m);

  if (!memAlerted && mem >= MEM_HI) {
    memAlerted = true;
    await send(
      "🔴 메모리 높음",
      `사용률 ${pct(mem)} (가용 ${gb(m.memAvailable)} / ${gb(m.memTotal)}). ` +
        `OOM 위험 — 서비스 메모리 점검 필요.`,
      0xef4444,
    );
  } else if (memAlerted && mem < MEM_LO) {
    memAlerted = false;
    await send("✅ 메모리 회복", `사용률 ${pct(mem)}로 내려감.`, 0x22c55e);
  }

  try {
    const fs = await statfs(DISK_PROBE_PATH);
    const disk = diskUsage(Number(fs.blocks), Number(fs.bfree), Number(fs.bavail));
    const availGb = (Number(fs.bavail) * fs.bsize) / 1024 ** 3;
    if (!diskAlerted && disk >= DISK_HI) {
      diskAlerted = true;
      await send(
        "🔴 디스크 높음",
        `루트 파일시스템 사용률 ${pct(disk)} (가용 ${availGb.toFixed(1)}GB). ` +
          `가득 차면 게시 파이프라인·도커가 멈춤(2026-08-24 사고). 정리 또는 볼륨 확장 필요.`,
        0xef4444,
      );
    } else if (diskAlerted && disk < DISK_LO) {
      diskAlerted = false;
      await send("✅ 디스크 회복", `사용률 ${pct(disk)}로 내려감.`, 0x22c55e);
    }
  } catch (err) {
    captureException(err, { kind: "disk-read" });
  }

  if (m.swapTotal > 0 && !swapAlerted && swap >= SWAP_HI) {
    swapAlerted = true;
    await send(
      "🟠 스왑 과다 사용",
      `스왑 ${pct(swap)} 사용 (${gb(m.swapTotal - m.swapFree)} / ${gb(m.swapTotal)}). ` +
        `실메모리 압박 신호 — 방치 시 OOM으로 이어질 수 있음.`,
      0xf59e0b,
    );
  } else if (swapAlerted && swap < SWAP_LO) {
    swapAlerted = false;
    await send("✅ 스왑 정상", `스왑 사용 ${pct(swap)}로 내려감.`, 0x22c55e);
  }
}

// 봇이 부팅될 때 호스트가 방금 재부팅됐으면(자동 복구/수동) #alerts로 알린다.
// 컨테이너의 /proc/uptime은 호스트 커널 uptime을 반영하므로, 배포로 컨테이너만
// 재시작된 경우(호스트 uptime 큼)와 실제 호스트 재부팅(uptime 작음)을 구분한다.
const REBOOT_NOTIFY_THRESHOLD_S = 15 * 60;

export async function notifyIfRebooted(): Promise<void> {
  try {
    const raw = await readFile("/proc/uptime", "utf8");
    const seconds = Number(raw.trim().split(/\s+/)[0]);
    if (Number.isFinite(seconds) && seconds < REBOOT_NOTIFY_THRESHOLD_S) {
      await send(
        "🔄 서버 재부팅 감지",
        `호스트가 약 ${Math.round(seconds / 60)}분 전 부팅됨 — 봇 복귀했습니다. ` +
          `(CloudWatch 자동 재부팅 또는 수동 재부팅)`,
        0x3b82f6,
      );
    }
  } catch (err) {
    captureException(err, { kind: "reboot-notify" });
  }
}

export function startResourceMonitor(): void {
  setInterval(() => void check(), env.RESOURCE_INTERVAL_MS);
  void check();
  void notifyIfRebooted();
}
