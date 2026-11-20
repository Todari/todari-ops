const HOUR = 3600;
const MAX_AGE = {
  "vault-sync": 24 * HOUR,
  "vault-push": 36 * HOUR,
  "inbox-sweep": 36 * HOUR,
  "weekly-review": 8 * 24 * HOUR,
  "jp-snapshot": 36 * HOUR,
} as const;

const STATUS = {
  success: "🟢 성공",
  stale: "🟡 지연",
  failed: "🔴 실패",
  running: "⚪ 실행 중",
  stalled: "🟡 실행 지연",
  unknown: "⚪ 미확인",
} as const;

type JobName = keyof typeof MAX_AGE;
type JobStatus = keyof typeof STATUS;

interface JobHealth {
  job: JobName;
  status: JobStatus;
  last_attempt?: number;
  last_success?: number;
  exit_code?: number;
}

export interface HostOperations {
  hostname: string;
  observedAt: string;
  jobs: JobHealth[];
}

export function normalizeHostOperations(value: unknown, observedAt: string): HostOperations | undefined {
  const host = value as Partial<HostOperations> | null;
  if (!host || typeof host.hostname !== "string" || !/^[a-z0-9][a-z0-9.-]{0,62}$/i.test(host.hostname)) return;
  const jobs: JobHealth[] = [];
  const latest = Date.parse(observedAt) / 1000 + 5 * 60;
  const timestamp = (n: unknown) => typeof n === "number" && n > 0 && n <= latest ? n : undefined;
  if (Array.isArray(host.jobs)) {
    for (const row of host.jobs.slice(0, Object.keys(MAX_AGE).length)) {
      if (!row || typeof row.job !== "string" || !Object.hasOwn(MAX_AGE, row.job)) continue;
      if (typeof row.status !== "string" || !Object.hasOwn(STATUS, row.status) || jobs.some((job) => job.job === row.job)) continue;
      jobs.push({
        job: row.job,
        status: row.status,
        last_attempt: timestamp(row.last_attempt),
        last_success: timestamp(row.last_success),
        exit_code: Number.isInteger(row.exit_code) && Math.abs(row.exit_code!) <= 255 ? row.exit_code : undefined,
      });
    }
  }
  return { hostname: host.hostname.toLowerCase(), observedAt, jobs };
}

export function formatHostOperations(hosts: HostOperations[], now = Date.now()): string {
  if (!hosts.length) return "⚪ Mac 운영 원장 미수신";
  return hosts.map((host) => {
    const received = Math.floor(Date.parse(host.observedAt) / 1000);
    const nowSeconds = now / 1000;
    const stale = nowSeconds - received > MAX_AGE["vault-sync"];
    const jobs = (Object.keys(MAX_AGE) as JobName[]).map((name) => {
      // The sender reads its ledger inside vault-sync, while that run is still marked running.
      if (name === "vault-sync") return `vault-sync ${stale ? "🟡 수신 지연" : "🟢 수신"}`;
      const row = host.jobs.find((job) => job.job === name);
      let status = row?.status ?? "unknown";
      if (status === "success" && nowSeconds - (row?.last_success ?? 0) > MAX_AGE[name]) status = "stale";
      if (status === "running" && nowSeconds - (row?.last_attempt ?? 0) > HOUR) status = "stalled";
      const code = status === "failed" && row?.exit_code !== undefined ? ` (${row.exit_code})` : "";
      return `${name} ${STATUS[status]}${code}`;
    });
    return `**${host.hostname}** <t:${received}:R>\n${jobs.join(" · ")}`;
  }).join("\n");
}
