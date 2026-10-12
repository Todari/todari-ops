// 위임(docs/delegation.md): 아침 다이제스트의 `🤖 위임` 버튼을 누르면 그 할 일을 `@claude` 를 부르는 GitHub 이슈로 올린다.
// 그 레포에 설치된 Claude Code GitHub Action 이 브랜치에서 작업하고, 열린 PR 은 다음 날 다이제스트의 "열린 PR"에 보인다.
// ▶ 버튼의 대화형 세션은 도구 승인을 눌러 줘야 해서 쓰이지 않았다. 자리를 지키지 않아도 되는 길을 레포 하나에서 시험한다.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Embed,
  type TopLevelComponent,
} from "discord.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { clip, within } from "../daily-log/evidence.js";
import { env } from "../env.js";
import { ghJson, ghPost } from "../github/api.js";
import { findProject, repoFullName } from "../projects.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { editInOrder } from "../task-loop/tidy.js";

/** 다이제스트가 넘기는 후보. ▶ 버튼과 같은 할 일이다. */
export interface DelegateTask {
  /** 카탈로그 프로젝트(src/projects.ts). 이슈를 올릴 레포를 정한다. */
  slug: string;
  note: string;
  text: string;
}

interface Delegation {
  /** 다이제스트에 마지막으로 실은 시각. */
  at: number;
  fullName: string;
  note: string;
  text: string;
  /** 올린 이슈. 있으면 다시 올리지 않는다. */
  issueUrl?: string;
}

const FILE = path.resolve(env.WORK_DIR, "..", "delegations.json");
const KEEP_MS = 7 * 24 * 3600_000;
// 공식 설치(`/install-github-app`)가 만드는 워크플로. 기본 브랜치에 이 파일이 있는 레포만 `@claude` 이슈를 받아 준다.
const WORKFLOW = ".github/workflows/claude.yml";
const READY_TTL_MS = 3600_000;
// 다이제스트는 이 답을 받아야 나간다. 이 시간을 넘긴 레포는 버튼 없이 게시한다.
const READY_TIMEOUT_MS = 3_000;
const FIELD = "🤖 위임";
const MAX_BUTTONS = 3;
const MAX_LABEL = 78; // ▶ 버튼의 라벨과 같은 길이
const MAX_TITLE = 120;

/** 7일이 지난 후보(와 읽을 수 없는 항목)는 없는 것으로 본다. 다음에 쓸 때 파일에서도 빠진다. */
function load(): Record<string, Delegation> {
  const oldest = Date.now() - KEEP_MS;
  return Object.fromEntries(
    Object.entries(readJsonObject<Delegation | null>(FILE)).filter(
      (entry): entry is [string, Delegation] => (entry[1]?.at ?? 0) >= oldest,
    ),
  );
}

/** 읽고·고치고·쓰기를 한 틱에 끝낸다. */
function update(change: (saved: Record<string, Delegation>) => void): void {
  const saved = load();
  change(saved);
  writeJsonObject(FILE, saved);
}

/** 레포와 노트와 문장으로 만든 짧은 id. 다이제스트를 다시 올려도 같은 할 일은 같은 id 라 이슈가 두 번 올라가지 않는다. */
const taskId = (fullName: string, note: string, text: string) =>
  createHash("sha1").update(`${fullName}\n${note}\n${text}`).digest("hex").slice(0, 8);

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral }) as const;
const filedLine = (url: string) => `🤖 위임함: ${url}`;

// 레포 → 준비됐다고 확인한 시각.
const readyAt = new Map<string, number>();

/**
 * 그 레포가 위임을 받을 준비가 됐는지. 조회 실패와 시간 초과는 준비되지 않은 것으로 치고, 던지지 않는다.
 * 준비됐다는 답만 한 시간 기억한다. ghJson 은 "워크플로 없음"과 "조회 실패"를 가르지 않는 데다,
 * 아니라는 답까지 기억하면 워크플로를 막 설치하고 `/digest` 를 불러도 한 시간 동안 버튼이 나오지 않는다.
 */
export async function delegationReady(fullName: string): Promise<boolean> {
  const confirmed = readyAt.get(fullName);
  if (confirmed !== undefined && Date.now() - confirmed < READY_TTL_MS) return true;
  const asked = ghJson<{ type?: string }>(`/repos/${fullName}/contents/${WORKFLOW}`).then(
    (file) => {
      if (file?.type !== "file") return false;
      // 시간 초과 뒤에 도착한 답도 기억해 다음 다이제스트가 쓴다.
      readyAt.set(fullName, Date.now());
      return true;
    },
    () => false,
  );
  return (await within(READY_TIMEOUT_MS, asked)) ?? false;
}

/**
 * 다이제스트의 `🤖 위임` 버튼 줄. ▶ 버튼의 후보(최대 3개) 가운데 레포가 준비된 것만 싣고, 하나도 없으면 줄도 없다.
 * 실은 후보는 /data 에 남겨 버튼이 재시작을 넘긴다.
 */
export async function delegateRows(
  tasks: DelegateTask[],
): Promise<Array<ActionRowBuilder<ButtonBuilder>>> {
  const offered = tasks.slice(0, MAX_BUTTONS).flatMap((task) => {
    const project = findProject(task.slug);
    const fullName = project && repoFullName(project);
    return fullName ? [{ ...task, fullName, id: taskId(fullName, task.note, task.text) }] : [];
  });
  // 레포마다 한 번씩, 한꺼번에 묻는다.
  const repos = [...new Set(offered.map((task) => task.fullName))];
  const answers = await Promise.all(repos.map(delegationReady));
  const ready = new Set(repos.filter((_, i) => answers[i]));
  // 같은 문장이 두 번 적힌 할 일은 버튼 하나다. 한 메시지에 같은 customId 가 둘이면 Discord 가 게시를 거부한다.
  const buttons = new Map(
    offered.filter((task) => ready.has(task.fullName)).map((task) => [task.id, task]),
  );
  if (buttons.size === 0) return [];
  update((saved) => {
    for (const { id, fullName, note, text } of buttons.values()) {
      // 이미 올린 이슈(issueUrl)는 남긴다.
      saved[id] = { ...saved[id], at: Date.now(), fullName, note, text };
    }
  });
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      [...buttons.values()].map((task) =>
        new ButtonBuilder()
          .setCustomId(`delegate:file:${task.id}`)
          .setLabel(clip(`🤖 위임 ${task.slug}: ${task.text}`, MAX_LABEL))
          .setStyle(ButtonStyle.Secondary),
      ),
    ),
  ];
}

function issueBody(task: Delegation): string {
  return [
    "@claude 아래 할 일을 맡아줘.",
    "",
    "## 할 일",
    "",
    `> ${task.text}`,
    "",
    `볼트 노트: ${task.note}`,
    "",
    "## 진행 방법",
    "",
    "- 새 브랜치에서 작업하고 pull request 를 연다.",
    "- 기본 브랜치에는 절대 직접 push 하지 않는다.",
    "- 레포의 테스트를 실행하고 그 결과를 PR 설명에 적는다.",
    "- 할 일이 불분명하면 작업을 멈추고 이 이슈에 질문을 남긴다.",
  ].join("\n");
}

/** 첫 임베드의 위임 칸에 한 줄을 더한다(없으면 칸을 붙인다). 다른 칸과 나머지 임베드는 그대로 둔다. */
function withLine(embeds: readonly Embed[], line: string): Array<EmbedBuilder | Embed> {
  const first = EmbedBuilder.from(embeds[0] ?? {});
  const fields = first.data.fields ?? [];
  first.setFields(
    fields.some((field) => field.name === FIELD)
      ? fields.map((field) =>
          field.name === FIELD ? { ...field, value: `${field.value}\n${line}` } : field,
        )
      : [...fields, { name: FIELD, value: line }],
  );
  return [first, ...embeds.slice(1)];
}

/** 그 버튼만 뺀다. 줄이 비면 줄도 뺀다. 다른 줄은 받은 그대로 돌려준다. */
function withoutButton(rows: readonly TopLevelComponent[], customId: string) {
  return rows.flatMap<TopLevelComponent | ActionRowBuilder<ButtonBuilder>>((row) => {
    if (
      row.type !== ComponentType.ActionRow ||
      !row.components.some((component) => component.customId === customId)
    ) {
      return [row];
    }
    const rest = row.components.flatMap((component) =>
      component.type === ComponentType.Button && component.customId !== customId
        ? [ButtonBuilder.from(component)]
        : [],
    );
    return rest.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(rest)] : [];
  });
}

// 처리 중인 후보. 버튼을 연달아 눌러도 이슈는 하나만 올린다.
const filing = new Set<string>();

/**
 * 다이제스트의 위임 버튼(`delegate:file:<id>`)과 공개 레포의 확인 버튼(`delegate:confirm:<id>:<다이제스트 메시지 id>`).
 * 비공개 레포는 바로 이슈를 올린다. 공개 레포는 할 일이 공개된다는 것을 먼저 알리고, 확인 버튼을 눌러야 올린다.
 */
export async function handleDelegateButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, id = "", confirmedFor] = interaction.customId.split(":");
  const task = load()[id];
  if (!task) {
    await interaction.reply(
      ephemeral("이 위임 버튼은 만료됨 (7일) — `/digest` 로 새 목록을 받아주세요"),
    );
    return;
  }
  if (task.issueUrl) {
    await interaction.reply(ephemeral(`이미 위임한 할 일입니다: ${task.issueUrl}`));
    return;
  }
  if (filing.has(id)) {
    await interaction.reply(ephemeral("이미 처리 중입니다 — 잠시만 기다려주세요"));
    return;
  }
  filing.add(id);
  try {
    // GitHub 호출은 3초를 넘길 수 있다.
    await interaction.deferUpdate();
    if (action !== "confirm") {
      const repo = await ghJson<{ private?: boolean }>(`/repos/${task.fullName}`);
      if (repo?.private === false) {
        await interaction.followUp({
          ...ephemeral(
            `⚠️ **${task.fullName}** 는 공개 레포입니다. 올리면 아래 할 일과 볼트 노트 이름(**${task.note}**)이 ` +
              `누구나 볼 수 있는 공개 이슈가 됩니다.\n> ${clip(task.text, 300)}`,
          ),
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                // 확인 버튼은 이 임시 메시지에 달린다. 올린 뒤 고칠 다이제스트 메시지는 id 로 들고 간다.
                .setCustomId(`delegate:confirm:${id}:${interaction.message.id}`)
                .setLabel("공개 이슈로 올리기")
                .setStyle(ButtonStyle.Danger),
            ),
          ],
        });
        return;
      }
      // 비공개라는 답을 받았을 때만 묻지 않고 올린다. 답이 없으면 공개 레포일 수 있다.
      if (repo?.private !== true) {
        await interaction.followUp(
          ephemeral(
            `⚠️ **${task.fullName}** 의 공개 여부를 확인하지 못해 올리지 않았습니다. 잠시 후 다시 눌러주세요.`,
          ),
        );
        return;
      }
    }
    const title = clip(task.text, MAX_TITLE);
    // 시간 초과로 실패한 POST 는 실제로는 올라갔을 수 있다. 같은 제목의 열린 이슈가 이미 있으면 그것을 올린 이슈로 보고
    // 또 올리지 않는다(이 목록에는 PR 도 섞여 온다). 목록을 받지 못하면 중복인지 알 수 없으니 올리지 않는다.
    // ponytail: 가장 최근에 열린 50개만 본다. 열린 이슈·PR 이 그보다 많이 쌓이는 레포라면 제목 검색으로 바꾼다.
    const open = await ghJson<Array<{ title?: string; html_url?: string; pull_request?: unknown }>>(
      `/repos/${task.fullName}/issues?state=open&per_page=50`,
    );
    if (!Array.isArray(open)) {
      await interaction.followUp(
        ephemeral(
          `⚠️ **${task.fullName}** 의 열린 이슈를 확인하지 못해 올리지 않았습니다. GitHub 응답과 \`GITHUB_TOKEN\` 의 Issues 권한을 확인해주세요.`,
        ),
      );
      return;
    }
    const issue =
      open.find((found) => !found.pull_request && found.title === title) ??
      (await ghPost<{ html_url?: string }>(`/repos/${task.fullName}/issues`, {
        title,
        body: issueBody(task),
      }));
    if (!issue?.html_url) {
      await interaction.followUp(
        ephemeral(
          `⚠️ **${task.fullName}** 에 이슈를 올리지 못했습니다. GitHub 응답과 \`GITHUB_TOKEN\` 의 Issues 쓰기 권한을 확인해주세요.`,
        ),
      );
      return;
    }
    const issueUrl = issue.html_url;
    const line = filedLine(issueUrl);
    // 메시지를 고치기 전에 남긴다. 고치다 실패해도 다시 누르면 올리지 않고 이 주소를 답한다.
    update((saved) => {
      saved[id] = { ...(saved[id] ?? task), issueUrl };
    });
    // 확인 버튼은 임시 메시지에 달려 있다. 그 메시지는 결과로 바꾸고, 다이제스트는 채널에서 찾아 고친다.
    const confirmed = action === "confirm";
    try {
      if (confirmed) await interaction.editReply({ content: line, components: [] });
      await editInOrder(async () => {
        // 올리는 사이 다른 버튼이 다이제스트를 바꿨을 수 있다. 지금의 메시지를 다시 읽어 그 위에 고친다.
        const digest = confirmed
          ? await interaction.channel!.messages.fetch({ message: confirmedFor ?? "", force: true })
          : await interaction.fetchReply();
        const marked = {
          embeds: withLine(digest.embeds, line),
          components: withoutButton(digest.components, `delegate:file:${id}`),
        };
        await (confirmed ? digest.edit(marked) : interaction.editReply(marked));
      });
    } catch (err) {
      // 이슈는 이미 올라갔다. 메시지를 고치지 못해도 주소는 알린다.
      console.warn("[delegate] message update failed:", err);
      await interaction.followUp(ephemeral(`${line}\n(다이제스트 메시지에는 적지 못했습니다)`));
    }
  } finally {
    filing.delete(id);
  }
}
