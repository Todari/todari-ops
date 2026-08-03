import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Message,
} from "discord.js";
import { askText, extractJson } from "../llm.js";
import { fetchInboxChannel } from "../discord/alerts.js";
import { answerQuestion, correctSentence } from "../jp/tutor.js";
import { dueCards, insertMistake } from "../jp/cards.js";
import { askCodebase } from "../agent/ask-codebase.js";
import { spawnSessionThread } from "../agent/bootstrap.js";
import { isTurnActive } from "../agent/run.js";
import { answerVaultQuestion } from "./vault-answer.js";
import { findProject, projects } from "../projects.js";
import { postDigest } from "../digest/daily.js";
import { postWeekly } from "../digest/weekly.js";
import { postCheckinPrompt } from "../checkin/index.js";
import { addReminder, parseFireAt } from "../reminders/index.js";
import { getUptimeSnapshot } from "../monitor/uptime.js";
import { listSessions } from "../storage/sessions.js";
import {
  collectDeadlines,
  ddayLabel,
  getVaultState,
  vaultAgeHours,
} from "../vault/state.js";
import { captureException } from "../observability/sentry.js";

// #토다리의 자연어 메시지를 최근 대화와 함께 분류하고, 허용된 내부 기능을
// 직접 호출한다. 코드 변경은 이 채널에서 실행하지 않고 기존 /code 와 같은
// 권한형 에이전트 스레드를 만든다.

export type Intent =
  | "note"
  | "task"
  | "idea"
  | "jp_ask"
  | "jp_fix"
  | "jp_review"
  | "codebase"
  | "code"
  | "vault"
  | "status"
  | "remind"
  | "digest"
  | "week"
  | "checkin"
  | "sessions"
  | "help"
  | "chat";

const INTENTS: Intent[] = [
  "note",
  "task",
  "idea",
  "jp_ask",
  "jp_fix",
  "jp_review",
  "codebase",
  "code",
  "vault",
  "status",
  "remind",
  "digest",
  "week",
  "checkin",
  "sessions",
  "help",
  "chat",
];

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Classified {
  intent: Intent;
  project?: string;
  text?: string;
  question?: string;
  sentence?: string;
  prompt?: string;
  when?: string;
  reply?: string;
}

const HISTORY_LIMIT = 14;
const MAX_HISTORY_CHARS = 6_000;
const PROJECT_CATALOG = projects
  .map((p) => `${p.slug}${p.aliases?.length ? `(${p.aliases.join("/")})` : ""}`)
  .join(", ");

const HELP_TEXT = [
  "말로 요청하면 아래 기능을 실행할 수 있어요.",
  "• 코드 수정·개발 → 프로젝트 에이전트 스레드 시작",
  "• 코드 위치·동작 질문 → 저장소 읽기 전용 조사",
  "• 할 일·메모·아이디어 저장, 볼트 일정·남은 일 조회",
  "• 일본어 질문·교정·복습",
  "• 상태·활성 세션 조회, 리마인더 설정",
  "• 일간 브리핑·주간 요약·저녁 체크인 게시",
  "",
  '예: "토다리봇 오늘의 표현에 N2 단어도 추가해줘", "30분 뒤 배포 확인하라고 알려줘"',
].join("\n");

export function buildPrompt(
  userText: string,
  history: ConversationTurn[] = [],
): string {
  const historyBlock =
    history.length === 0
      ? "(이전 대화 없음)"
      : history
          .map((turn) => `${turn.role === "user" ? "사용자" : "봇"}: ${turn.text}`)
          .join("\n")
          .slice(-MAX_HISTORY_CHARS);

  return (
    "너는 개인 Discord 운영 봇의 자연어 액션 라우터다. 최근 대화를 읽고 현재 메시지의 실제 요청을 해석해 JSON 하나만 출력해라(설명·코드펜스 금지).\n" +
    "대명사나 생략 표현(예: '그렇게 해줘', '너 추천대로')은 최근 대화로 해소한다.\n" +
    "실행 액션과 필드:\n" +
    '- "note": 기존 기록을 바꾸거나 기억해달라는 요청. text, 선택 project.\n' +
    '- "task": 할 일 추가. text, 선택 project.\n' +
    '- "idea": 아이디어 저장. text.\n' +
    '- "jp_ask": 일본어 학습 질문. question.\n' +
    '- "jp_fix": 사용자가 쓴 일본어 문장 교정. sentence.\n' +
    '- "jp_review": 일본어 복습 시작.\n' +
    '- "codebase": 코드를 수정하지 않는 저장소 질문·원인 조사. project, question.\n' +
    '- "code": 기능 추가·수정·버그 수정·테스트·배포 준비 등 실제 개발 요청. project, prompt. prompt는 최근 대화의 요구사항과 합의 내용을 포함한 독립적으로 이해 가능한 작업 지시로 다시 써라.\n' +
    '- "vault": 프로젝트 마감·일정·남은 할 일 질문. question.\n' +
    '- "status": 서비스·마감·할 일 상태 조회.\n' +
    '- "remind": 리마인더 설정. when은 30m/2h/1d/HH:MM 중 하나, text는 알림 내용.\n' +
    '- "digest": 오늘 브리핑/일간 다이제스트 게시.\n' +
    '- "week": 주간 요약 게시.\n' +
    '- "checkin": 저녁 체크인 게시.\n' +
    '- "sessions": 활성 개발 세션 조회.\n' +
    '- "help": 봇 기능이나 사용법 질문.\n' +
    '- "chat": 실행할 기능이 없는 일반 대화. 이때만 reply에 최근 대화를 반영한 한국어 답변.\n' +
    `project는 다음 slug 중 하나로 정규화: ${PROJECT_CATALOG}.\n` +
    "토다리봇·Discord 봇·오늘의 표현 push·이 봇 자체 기능은 todari-ops다. basetie는 jeongpyo다.\n" +
    "질문/설명 요청은 codebase, 변경해달라는 요청은 code다. 여러 해석이 가능하고 실행 의도가 불명확하면 chat으로 분류한다.\n" +
    "예시: 이전에 '오늘의 표현에 N2~N3 단어 5~10개도 넣자'고 합의한 뒤 '너 추천대로 해줘'라고 하면 " +
    '{"intent":"code","project":"todari-ops","prompt":"일본어 오늘의 표현 push에 N2~N3 단어 5~10개를 예문과 함께 추가해줘."}\n\n' +
    `[최근 대화]\n${historyBlock}\n\n[현재 메시지]\n${userText}`
  );
}

export function parseIntent(raw: string): Classified {
  let value: Record<string, unknown>;
  try {
    value = extractJson(raw) as Record<string, unknown>;
  } catch {
    return { intent: "chat", reply: raw.trim().slice(0, 1900) };
  }
  const intent: Intent = INTENTS.includes(value.intent as Intent)
    ? (value.intent as Intent)
    : "chat";
  return {
    intent,
    project: optionalString(value.project),
    text: optionalString(value.text),
    question: optionalString(value.question),
    sentence: optionalString(value.sentence),
    prompt: optionalString(value.prompt),
    when: optionalString(value.when),
    reply: optionalString(value.reply),
  };
}

export async function classify(
  userText: string,
  history: ConversationTurn[] = [],
): Promise<Classified> {
  const raw = await askText(buildPrompt(userText, history));
  return parseIntent(raw);
}

async function fetchRecentConversation(
  message: Message,
): Promise<ConversationTurn[]> {
  if (message.channel.type !== ChannelType.GuildText) return [];
  try {
    const fetched = await message.channel.messages.fetch({
      before: message.id,
      limit: HISTORY_LIMIT,
    });
    const botId = message.client.user?.id;
    return [...fetched.values()]
      .reverse()
      .filter(
        (item) =>
          item.content.trim() &&
          (item.author.id === message.author.id || item.author.id === botId),
      )
      .map((item) => ({
        role: item.author.id === botId ? "assistant" : "user",
        text: item.content.trim().slice(0, 800),
      }));
  } catch (err) {
    console.warn("[nl] recent history unavailable:", err);
    return [];
  }
}

async function queueCapture(
  kind: "note" | "task" | "idea",
  project: string | undefined,
  text: string,
): Promise<boolean> {
  const channel = await fetchInboxChannel();
  if (!channel) return false;
  await channel.send(`📥 [${kind}]${project ? ` (${project})` : ""} ${text}`);
  return true;
}

// 전용 채널의 소유자 메시지를 처리한다. 봇 자신·다른 사용자·스레드는 호출 전에 걸러진다.
export async function handleNaturalMessage(message: Message): Promise<void> {
  const content = message.content.trim();
  if (!content) return;
  try {
    if ("sendTyping" in message.channel) await message.channel.sendTyping();
    const history = await fetchRecentConversation(message);
    const classified = await classify(content, history);

    switch (classified.intent) {
      case "note":
      case "task":
      case "idea": {
        const body = classified.text || content;
        const project = resolveProjectSlug(classified.project);
        const ok = await queueCapture(classified.intent, project, body);
        const label =
          classified.intent === "idea"
            ? "아이디어"
            : classified.intent === "task"
              ? "할 일"
              : "메모";
        await message.reply(
          ok
            ? `📥 ${label}로 담았어요${project ? ` (${project})` : ""} — 다음 스윕 때 볼트에 반영됩니다.`
            : "⚠️ 인박스 채널을 못 찾았어요.",
        );
        return;
      }
      case "jp_ask": {
        const answer = await answerQuestion(classified.question || content);
        await message.reply(answer.slice(0, 1900));
        return;
      }
      case "jp_fix": {
        const jp = classified.sentence || content;
        const correction = await correctSentence(jp);
        await insertMistake({
          original: jp,
          corrected: correction.corrected,
          reason: correction.mistakes.join("; "),
        });
        const out =
          `**교정:** ${correction.corrected}` +
          (correction.natural
            ? `\n**자연스럽게:** ${correction.natural}`
            : "") +
          `\n**설명:** ${correction.explanation}`;
        await message.reply(out.slice(0, 1900));
        return;
      }
      case "jp_review": {
        await replyWithJpReview(message);
        return;
      }
      case "vault": {
        const ack = await message.reply("🔎 볼트 뒤져볼게요… (조금 걸려요)");
        const answer = await answerVaultQuestion(
          classified.question || content,
        );
        await ack.edit(answer.slice(0, 1900));
        return;
      }
      case "codebase": {
        const project = classified.project
          ? findProject(classified.project)
          : undefined;
        if (!project) {
          await message.reply(
            `어느 레포를 볼까요? (${projects.map((p) => p.slug).join(", ")})`,
          );
          return;
        }
        const ack = await message.reply(
          `🔎 \`${project.slug}\` 코드 뒤져볼게요… (조금 걸려요)`,
        );
        const answer = await askCodebase(
          project,
          classified.question || content,
        );
        await ack.edit(answer.slice(0, 1900));
        return;
      }
      case "code": {
        const project = classified.project
          ? findProject(classified.project)
          : undefined;
        if (!project) {
          await message.reply(
            `어느 프로젝트에서 작업할까요? (${projects.map((p) => p.slug).join(", ")})`,
          );
          return;
        }
        if (message.channel.type !== ChannelType.GuildText) {
          await message.reply("개발 세션은 서버 텍스트 채널에서만 시작할 수 있어요.");
          return;
        }
        const prompt =
          classified.prompt ||
          buildContextualCodePrompt(content, history);
        const thread = await spawnSessionThread({
          parent: message.channel,
          threadName: `${project.slug}/${truncate(prompt, 76)}`,
          projectSlug: project.slug,
          permissionMode: "default",
          prompt,
        });
        await message.reply(
          `🚀 ${project.name} 개발 세션을 시작했어요 → ${thread}\n코드 변경 권한은 스레드에서 확인합니다.`,
        );
        return;
      }
      case "status": {
        await message.reply(buildStatusText().slice(0, 1900));
        return;
      }
      case "remind": {
        const when = classified.when?.trim();
        const text = classified.text?.trim();
        const fireAt = when ? parseFireAt(when) : null;
        if (!fireAt || !text) {
          await message.reply(
            '시간과 내용을 함께 말해주세요. 예: "30분 뒤 배포 확인하라고 알려줘"',
          );
          return;
        }
        await addReminder({
          channelId: message.channelId,
          content: text,
          fireAt,
        });
        await message.reply(
          `⏰ ${formatKst(fireAt)} KST에 알려드릴게요 — "${truncate(text, 80)}"`,
        );
        return;
      }
      case "digest": {
        const posted = await postDigest();
        await message.reply(
          posted
            ? "☀️ 오늘 브리핑을 게시했어요."
            : "⚠️ 다이제스트 채널을 찾지 못했어요.",
        );
        return;
      }
      case "week": {
        const posted = await postWeekly();
        await message.reply(
          posted
            ? "📅 주간 요약을 게시했어요."
            : "⚠️ 다이제스트 채널을 찾지 못했어요.",
        );
        return;
      }
      case "checkin": {
        const posted = await postCheckinPrompt();
        await message.reply(
          posted
            ? "🌙 저녁 체크인을 게시했어요."
            : "⚠️ 다이제스트 채널을 찾지 못했어요.",
        );
        return;
      }
      case "sessions": {
        await message.reply(buildSessionsText());
        return;
      }
      case "help": {
        await message.reply(HELP_TEXT);
        return;
      }
      default:
        await message.reply(
          (
            classified.reply ||
            "무슨 뜻인지 잘 모르겠어요. 다시 말해줄래요?"
          ).slice(0, 1900),
        );
    }
  } catch (err) {
    captureException(err, { kind: "nl-router" });
    try {
      await message.reply("⚠️ 처리 중 문제가 생겼어요. 잠시 후 다시 시도해줘.");
    } catch {
      /* ignore */
    }
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 4_000) : undefined;
}

function resolveProjectSlug(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return findProject(value)?.slug ?? value;
}

function buildContextualCodePrompt(
  current: string,
  history: ConversationTurn[],
): string {
  const context = history
    .slice(-8)
    .map((turn) => `${turn.role === "user" ? "사용자" : "봇"}: ${turn.text}`)
    .join("\n");
  return [
    "아래 Discord 대화의 합의와 현재 요청을 바탕으로 작업해줘.",
    context ? `\n[최근 대화]\n${context}` : "",
    `\n[현재 요청]\n${current}`,
  ].join("");
}

function buildStatusText(): string {
  const lines = ["📊 **상태 한눈에**"];
  const uptime = getUptimeSnapshot();
  if (uptime.length > 0) {
    lines.push(
      "",
      "**서비스**",
      ...uptime.map(
        (item) =>
          `${item.up ? "🟢" : "🔴"} ${item.slug} (${item.detail})`,
      ),
    );
  }

  const vault = getVaultState();
  if (!vault) {
    lines.push("", "**볼트**", "동기화 데이터 없음");
    return lines.join("\n");
  }

  const deadlines = collectDeadlines(vault, 0, 30).slice(0, 5);
  if (deadlines.length > 0) {
    lines.push(
      "",
      "**마감**",
      ...deadlines.map(
        (item) =>
          `${ddayLabel(item.d)} ${item.date.slice(5)} · [${item.note}] ${item.text}`,
      ),
    );
  }
  const taskCounts = vault.notes
    .filter((note) => note.tasks.length > 0)
    .map((note) => `${note.note} ${note.tasks.length}`)
    .join(" · ");
  if (taskCounts) lines.push("", `**열린 할 일**\n${taskCounts}`);
  lines.push("", `볼트 동기화 ${Math.round(vaultAgeHours(vault))}시간 전`);
  return lines.join("\n");
}

function buildSessionsText(): string {
  const sessions = listSessions();
  if (sessions.length === 0) return "활성 개발 세션이 없어요.";
  const lines = sessions.slice(0, 20).map((session) => {
    const age = Math.round((Date.now() - session.createdAt) / 3_600_000);
    const running = isTurnActive(session.threadId) ? " 🔄 실행 중" : "";
    return `<#${session.threadId}> · ${session.projectSlug} · ${age}h · \`${session.permissionMode}\`${running}`;
  });
  return `**활성 세션 ${sessions.length}개**\n${lines.join("\n")}`;
}

async function replyWithJpReview(message: Message): Promise<void> {
  const cards = await dueCards(new Date(), 1);
  if (cards.length === 0) {
    await message.reply("복습할 카드 없음 🎉");
    return;
  }
  const card = cards[0];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`jp:again:${card.id}`)
      .setLabel("모름")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`jp:hard:${card.id}`)
      .setLabel("애매")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`jp:good:${card.id}`)
      .setLabel("알았음")
      .setStyle(ButtonStyle.Success),
  );
  await message.reply({
    content: `**${card.meaning}**\n||${card.front} (${card.reading}) — ${card.example}||`,
    components: [row],
  });
}

function formatKst(timestamp: number): string {
  return new Date(timestamp + 9 * 3_600_000)
    .toISOString()
    .slice(5, 16)
    .replace("T", " ");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
