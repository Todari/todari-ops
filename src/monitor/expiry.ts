import { connect as tlsConnect } from "node:tls";
import { resolveNs } from "node:dns/promises";
import { EmbedBuilder } from "discord.js";
import { projects } from "../projects.js";
import { fetchAlertsChannel } from "../discord/alerts.js";
import { env } from "../env.js";
import { captureException } from "../observability/sentry.js";
import { todayKst } from "../vault/state.js";

// 도메인(RDAP)·TLS 인증서 만료 감시. 매일 1회 검사하되 마일스톤
// 일자에만 경고해 스팸을 막고, 미등록 도메인은 월요일마다 상기시킨다.

const DOMAIN_MILESTONES = new Set([60, 30, 14, 7, 3, 2, 1, 0]);
const CERT_MILESTONES = new Set([21, 14, 7, 3, 2, 1, 0]);
const CHECK_INTERVAL_MS = 24 * 3600_000;
const BOT_HOST = env.BOT_PUBLIC_HOST;

// 같은 날 중복 경고 방지 (재시작 시 하루 1회 재경고는 허용)
const alertedToday = new Set<string>();

export function startExpiryMonitor(): void {
  void sweep();
  setInterval(() => void sweep(), CHECK_INTERVAL_MS);
  console.log("[expiry] domain/cert monitor started (daily)");
}

function targets(): { domains: string[]; hosts: string[] } {
  const hosts = new Set<string>();
  const domains = new Set<string>();
  if (BOT_HOST) hosts.add(BOT_HOST);
  for (const p of projects) {
    if (!p.healthUrl) continue;
    const host = new URL(p.healthUrl).hostname;
    hosts.add(host);
    if (!host.endsWith(".vercel.app")) domains.add(registrableDomain(host));
  }
  if (BOT_HOST) domains.add(registrableDomain(BOT_HOST));
  return { domains: [...domains].sort(), hosts: [...hosts].sort() };
}

// 이 프로젝트의 TLD 들(.dev/.my/.pro/.site)은 전부 2-label 등록 도메인이다.
function registrableDomain(host: string): string {
  return host.split(".").slice(-2).join(".");
}

async function sweep(): Promise<void> {
  const { domains, hosts } = targets();
  for (const domain of domains) {
    try {
      await checkDomain(domain);
    } catch (err) {
      console.warn(`[expiry] domain check failed for ${domain}:`, err);
    }
  }
  for (const host of hosts) {
    try {
      await checkCert(host);
    } catch {
      // 다운/미해석 호스트는 uptime 모니터 담당 — 여기선 조용히 넘어간다.
    }
  }
}

async function checkDomain(domain: string): Promise<void> {
  const isMondayKst = new Date(Date.now() + 9 * 3600_000).getUTCDay() === 1;
  const res = await fetch(`https://rdap.org/domain/${domain}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "todari-ops-expiry/1.0" },
  });

  if (res.status === 404) {
    // 404 는 "미등록" 또는 "TLD 가 RDAP 미지원"(.my 등) 둘 다일 수 있다 —
    // NS 가 살아있으면 등록된 것이므로 오탐 방지를 위해 조용히 넘어간다.
    const resolves = await resolveNs(domain).then(
      (ns) => ns.length > 0,
      () => false,
    );
    if (!resolves && isMondayKst) {
      await alertOnce(
        `domain-unreg:${domain}`,
        new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle(`🪦 도메인 미등록: ${domain}`)
          .setDescription("등록이 만료·해제된 상태입니다. 재등록하거나 서비스 URL을 이전하세요."),
      );
    }
    return;
  }
  if (!res.ok) return;

  const data = (await res.json()) as {
    status?: string[];
    events?: Array<{ eventAction?: string; eventDate?: string }>;
  };

  // hold/redemption/pending delete = 레지스트라가 도메인을 정지시킨 상태
  // (갱신 미결제 등). 유예기간이 지나면 잃는다 — 해결될 때까지 매일 경고.
  const bad = (data.status ?? []).filter((s) => /hold|redemption|pending ?delete/i.test(s));
  if (bad.length > 0) {
    await alertOnce(
      `domain-hold:${domain}`,
      new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle(`🚨 도메인 정지 상태: ${domain} (${bad.join(", ")})`)
        .setDescription(
          "레지스트라가 도메인을 hold 중 — 대개 갱신 미결제. **레지스트라에서 갱신 결제하면 복구**되지만, 유예기간이 끝나면 redemption 수수료가 붙거나 도메인을 잃습니다. 지금 확인하세요.",
        ),
    );
    return;
  }

  const exp = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
  if (!exp) return;
  const days = daysUntilMs(Date.parse(exp));
  // 마일스톤 일자 + (60일 이내면) 월요일 주간 리마인드.
  if (days <= 60 && (DOMAIN_MILESTONES.has(Math.max(days, 0)) || isMondayKst)) {
    await alertOnce(
      `domain:${domain}`,
      new EmbedBuilder()
        .setColor(days <= 14 ? 0xef4444 : 0xf97316)
        .setTitle(`⏳ 도메인 만료 D-${Math.max(days, 0)}: ${domain}`)
        .setDescription(`만료일 ${exp.slice(0, 10)} — 갱신하지 않으면 서비스가 내려갑니다.`),
    );
  }
}

function checkCert(host: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = tlsConnect(
      { host, port: 443, servername: host, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const validTo = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
        if (Number.isNaN(validTo)) return resolve();
        const days = daysUntilMs(validTo);
        if (days <= 21 && CERT_MILESTONES.has(Math.max(days, 0))) {
          void alertOnce(
            `cert:${host}`,
            new EmbedBuilder()
              .setColor(days <= 7 ? 0xef4444 : 0xf97316)
              .setTitle(`🔒 TLS 인증서 만료 D-${Math.max(days, 0)}: ${host}`)
              .setDescription(
                host === BOT_HOST
                  ? "봇 호스트 인증서 — EC2 에서 `sudo certbot renew` 상태를 확인하세요."
                  : "인증서 갱신(자동 갱신 실패 여부)을 확인하세요.",
              ),
          ).then(resolve, () => resolve());
          return;
        }
        resolve();
      },
    );
    socket.on("error", () => resolve());
    socket.on("timeout", () => {
      socket.destroy();
      resolve();
    });
  });
}

async function alertOnce(key: string, embed: EmbedBuilder): Promise<void> {
  const dayKey = `${key}:${todayKst()}`;
  if (alertedToday.has(dayKey)) return;
  alertedToday.add(dayKey);
  // 오래된 키 정리
  for (const k of alertedToday) {
    if (!k.endsWith(todayKst())) alertedToday.delete(k);
  }
  try {
    const channel = await fetchAlertsChannel();
    if (channel) await channel.send({ embeds: [embed] });
    console.log(`[expiry] alerted: ${key}`);
  } catch (err) {
    console.error("[expiry] alert failed:", err);
    captureException(err, { kind: "expiry" });
  }
}

function daysUntilMs(ms: number): number {
  return Math.floor((ms - Date.now()) / 86_400_000);
}
