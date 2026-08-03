import { Client, EmbedBuilder } from "discord.js";
import { env } from "../env.js";
import { generateDailyPhrase } from "./tutor.js";
import { insertCard, logDaily, recentDailyFronts } from "./cards.js";
import { fetchJpChannel } from "../discord/alerts.js";
import { captureException } from "../observability/sentry.js";

// 매일 JP_PUSH_HOUR:JP_PUSH_MINUTE(KST)에 회화 표현 1개를 생성해 카드로
// 저장하고 채널에 게시한다. digest/daily.ts · checkin/index.ts의
// self-reschedule + KST 고정 오프셋(UTC+9, DST 없음) 패턴을 그대로 따른다.

export function scheduleJpPush(client: Client): void {
  scheduleNext(client);
}

function scheduleNext(client: Client): void {
  const delay = msUntilNextKst(env.JP_PUSH_HOUR, env.JP_PUSH_MINUTE);
  console.log(
    `[jp-push] next run in ${Math.round(delay / 60_000)}min ` +
      `(${String(env.JP_PUSH_HOUR).padStart(2, "0")}:${String(env.JP_PUSH_MINUTE).padStart(2, "0")} KST)`,
  );
  setTimeout(async () => {
    try {
      await runJpPush(client);
    } catch (err) {
      console.error("[jp-push] failed:", err);
      captureException(err, { kind: "jp-push" });
    }
    scheduleNext(client);
  }, delay);
}

// `client` isn't read here — jp channel lookup goes through the discord
// client singleton (getDiscordClient(), same as fetchDigestChannel /
// fetchInboxChannel) — but the parameter is kept to match the task's
// produced interface (`runJpPush(client: Client)`), so it's prefixed to
// satisfy noUnusedParameters.
export async function runJpPush(_client: Client): Promise<void> {
  const channel = await fetchJpChannel();
  if (!channel) return;

  const phrase = await generateDailyPhrase(await recentDailyFronts(30));
  const tomorrow = new Date(Date.now() + 86_400_000);
  const id = await insertCard({ ...phrase, source: "daily", dueAt: tomorrow });
  await logDaily(new Date().toISOString().slice(0, 10), id);

  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle(`🇯🇵 오늘의 표현 — ${phrase.front}`)
    .setDescription(
      `**${phrase.reading}**\n${phrase.meaning}\n\n> ${phrase.example}\n> ${phrase.exampleKo}` +
        (phrase.note ? `\n\n💡 ${phrase.note}` : ""),
    );
  await channel.send({ embeds: [embed] });
}

// KST is fixed UTC+9 (no DST) — compute next HH:MM occurrence. Mirrors
// digest/daily.ts's msUntilNextKst / checkin/index.ts's msUntilKst.
function msUntilNextKst(hour: number, minute: number): number {
  const nowShifted = new Date(Date.now() + 9 * 3600_000);
  const target = new Date(nowShifted);
  target.setUTCHours(hour, minute, 0, 0);
  if (target.getTime() <= nowShifted.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - nowShifted.getTime();
}
