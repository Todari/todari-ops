import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import path from "node:path";
import { env } from "../env.js";
import { fetchInboxChannel } from "../discord/alerts.js";
import { inboxCapturePayload } from "../discord/inbox-capture.js";
import { saveTomorrowFirstTask } from "../checkin/index.js";
import { DeliveryQueue } from "../storage/delivery.js";

const checkinInbox = new DeliveryQueue<string>(
  path.resolve(env.WORK_DIR, "..", "checkin-inbox.json"),
  async (content, id) => {
    const channel = await fetchInboxChannel();
    if (!channel) throw new Error("Check-in inbox unavailable");
    await channel.send({ ...inboxCapturePayload(content), nonce: id, enforceNonce: true });
  },
);

export function startCheckinInbox(): void {
  checkinInbox.start();
}

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.user.id !== env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: "권한 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  const [kind, action, date] = interaction.customId.split(":");
  if (kind !== "checkin" || action !== "submit" || !date) return;

  const done = interaction.fields.getTextInputValue("done");
  const stuck = interaction.fields.getTextInputValue("stuck");
  const tomorrow = interaction.fields.getTextInputValue("tomorrow");
  const firstTaskText = tomorrow.trim();

  try {
    checkinInbox.enqueue(
      interaction.id,
      [`📥 [checkin] (${date}) 오늘: ${done}`, `막힘: ${stuck || "-"}`, `내일: ${tomorrow || "-"}`].join("\n"),
    );
  } catch (err) {
    console.warn("[checkin] save failed:", (err as Error).name);
    await interaction.reply({
      content: "⚠️ 체크인 원문을 저장하지 못했어요. 잠시 후 다시 제출해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const firstTask = firstTaskText
    ? saveTomorrowFirstTask(date, firstTaskText).then(() => true, (err: Error) => {
        console.warn("[checkin] first task save failed:", err.name);
        return false;
      })
    : true;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [posted, firstTaskSaved] = await Promise.all([checkinInbox.attempt(interaction.id), firstTask]);
  const delivery = posted ? "🌙 체크인을 인박스에 기록했어요." : "📥 체크인 원문을 보관했어요. 인박스 전송을 다시 시도합니다.";
  const task = firstTaskText && (firstTaskSaved
    ? ` 내일 아침 브리핑 맨 위에서 "${firstTaskText.slice(0, 60)}" 로 만나요.`
    : " 내일 첫 작업은 브리핑에 저장하지 못했어요.");
  await interaction.editReply(delivery + task);
}
