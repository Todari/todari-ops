import { MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import { env } from "../env.js";
import { pickToday } from "../task-loop/today.js";

export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.user.id !== env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: "권한 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  const [kind, action] = interaction.customId.split(":");

  if (kind === "today" && action === "pick") {
    await pickToday(interaction);
    return;
  }
}
