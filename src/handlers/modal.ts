import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import { env } from "../env.js";
import { fetchInboxChannel } from "../discord/alerts.js";
import { saveTomorrowFirstTask } from "../checkin/index.js";

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.user.id !== env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: "권한 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  const [kind, action, date] = interaction.customId.split(":");
  if (kind !== "checkin" || action !== "submit" || !date) return;

  const done = interaction.fields.getTextInputValue("done").trim();
  const stuck = interaction.fields.getTextInputValue("stuck").trim();
  const tomorrow = interaction.fields.getTextInputValue("tomorrow").trim();

  const channel = await fetchInboxChannel();
  if (channel) {
    await channel.send(
      [
        `📥 [checkin] (${date}) 오늘: ${done}`,
        `막힘: ${stuck || "-"}`,
        `내일: ${tomorrow || "-"}`,
      ].join("\n"),
    );
  }
  if (tomorrow) await saveTomorrowFirstTask(date, tomorrow);

  await interaction.reply({
    content: tomorrow
      ? `🌙 기록됨 — 내일 아침 브리핑 맨 위에서 "${tomorrow.slice(0, 60)}" 로 만나요`
      : "🌙 기록됨 — 잘 자요",
    flags: MessageFlags.Ephemeral,
  });
}
