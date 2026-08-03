import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { env } from "../env.js";
import { projects } from "../projects.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("code")
    .setDescription("Start a Claude Code session against a project")
    .addStringOption((opt) =>
      opt
        .setName("project")
        .setDescription("Which project")
        .setRequired(true)
        .addChoices(...projects.map((p) => ({ name: p.name, value: p.slug }))),
    )
    .addStringOption((opt) =>
      opt.setName("prompt").setDescription("Initial prompt").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Permission mode (default if omitted)")
        .setRequired(false)
        .addChoices(
          { name: "default (ask each time)", value: "default" },
          { name: "acceptEdits (auto-approve Edit/Write)", value: "acceptEdits" },
          { name: "bypass (auto-approve all — careful)", value: "bypassPermissions" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("perm")
    .setDescription("Set permission mode for current thread")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Permission mode")
        .setRequired(true)
        .addChoices(
          { name: "default (ask each time)", value: "default" },
          { name: "acceptEdits (auto-approve Edit/Write)", value: "acceptEdits" },
          { name: "bypass (auto-approve all — careful)", value: "bypassPermissions" },
        ),
    ),
  new SlashCommandBuilder().setName("cancel").setDescription("Cancel the running turn in this thread"),
  new SlashCommandBuilder().setName("end").setDescription("End and clean up this thread's session"),
  new SlashCommandBuilder().setName("ping").setDescription("Health check"),
  new SlashCommandBuilder().setName("digest").setDescription("Post today's digest now"),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Capture a task → inbox → vault (Mac sweeper)")
    .addStringOption((opt) =>
      opt.setName("content").setDescription("할 일 내용").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("project")
        .setDescription("Which project (optional)")
        .setRequired(false)
        .addChoices(...projects.map((p) => ({ name: p.name, value: p.slug }))),
    ),
  new SlashCommandBuilder()
    .setName("idea")
    .setDescription("Capture an idea → inbox → vault 창/")
    .addStringOption((opt) =>
      opt.setName("content").setDescription("아이디어 내용").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("자유 지시 → inbox → 스위퍼가 볼트를 해석해 편집 (예: 우선순위 낮춰)")
    .addStringOption((opt) =>
      opt.setName("content").setDescription("지시 내용 (자연어)").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("project")
        .setDescription("관련 프로젝트 (선택)")
        .setRequired(false)
        .addChoices(...projects.map((p) => ({ name: p.name, value: p.slug }))),
    ),
  new SlashCommandBuilder().setName("status").setDescription("Services + tasks + deadlines at a glance"),
  new SlashCommandBuilder().setName("week").setDescription("Post weekly summary now (auto: Fri 18:00 KST)"),
  new SlashCommandBuilder()
    .setName("remind")
    .setDescription("One-off reminder in this channel")
    .addStringOption((opt) =>
      opt.setName("when").setDescription("30m, 2h, 1d 또는 HH:MM (KST)").setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName("content").setDescription("알림 내용").setRequired(true),
    ),
  new SlashCommandBuilder().setName("sessions").setDescription("List active /code sessions"),
  new SlashCommandBuilder().setName("checkin").setDescription("Post the evening check-in prompt now"),
  new SlashCommandBuilder()
    .setName("jp")
    .setDescription("일본어 학습")
    .addSubcommand((s) =>
      s
        .setName("ask")
        .setDescription("질문하기")
        .addStringOption((o) => o.setName("q").setDescription("질문").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("fix")
        .setDescription("작문 교정")
        .addStringOption((o) =>
          o.setName("sentence").setDescription("일본어 문장").setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName("review").setDescription("복습 퀴즈")),
].map((c) => c.toJSON());

export async function registerSlashCommands(appId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
  console.log(`[discord] registered ${commands.length} slash commands`);
}
