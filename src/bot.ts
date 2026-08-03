import { captureException } from "./observability/sentry.js";
import { Events } from "discord.js";
import { env, assertEnv } from "./env.js";
import { createClient, login } from "./discord/client.js";
import { registerSlashCommands } from "./discord/commands.js";
import { startResourceMonitor } from "./monitor/resources.js";
import { handleSlash } from "./handlers/slash.js";
import { handleThreadMessage } from "./handlers/thread-message.js";
import { handleNaturalMessage } from "./nl/router.js";
import { handleButton } from "./handlers/button.js";
import { handleModalSubmit } from "./handlers/modal.js";
import { startWebhookServer } from "./webhook/server.js";
import { startUptimeMonitor } from "./monitor/uptime.js";
import { startExpiryMonitor } from "./monitor/expiry.js";
import { startDailyDigest } from "./digest/daily.js";
import { startWeeklySummary } from "./digest/weekly.js";
import { startReminders } from "./reminders/index.js";
import { startEveningCheckin } from "./checkin/index.js";
import { scheduleJpPush } from "./jp/daily-push.js";

assertEnv();

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  captureException(err, { kind: "uncaughtException" });
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  captureException(reason, { kind: "unhandledRejection" });
});

const client = createClient();

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  console.log(`[bot] WORK_DIR=${env.WORK_DIR}`);
  await registerSlashCommands(env.DISCORD_APP_ID, env.DISCORD_GUILD_ID);
  if (env.WEBHOOK_ENABLED) startWebhookServer();
  else console.log("[webhook] disabled (WEBHOOK_ENABLED=false)");
  startUptimeMonitor();
  startResourceMonitor();
  startExpiryMonitor();
  startDailyDigest();
  startWeeklySummary();
  startReminders();
  startEveningCheckin();
  scheduleJpPush(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlash(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  } catch (err) {
    console.error("[interaction] error:", err);
    captureException(err, {
      kind: interaction.isChatInputCommand()
        ? "slash"
        : interaction.isButton()
          ? "button"
          : "interaction",
    });
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== env.OWNER_DISCORD_ID) return;
  // 전용 자연어 채널: 명령어 없이 그냥 말하면 의도 분류→라우팅.
  if (env.NL_CHANNEL_ID && message.channelId === env.NL_CHANNEL_ID) {
    try {
      await handleNaturalMessage(message);
    } catch (err) {
      console.error("[nl] error:", err);
      captureException(err, { kind: "nl-message", channelId: message.channelId });
    }
    return;
  }
  // /code 세션 스레드: 에이전트 대화 이어가기.
  if (!message.channel.isThread()) return;
  try {
    await handleThreadMessage(message);
  } catch (err) {
    console.error("[message] error:", err);
    captureException(err, { kind: "thread-message", channelId: message.channelId });
  }
});

await login(client, env.DISCORD_BOT_TOKEN);
