// 음성 캡처(docs/voice-capture.md): 인박스 채널에 올린 음성 메시지를 Gemini 한 번의 호출로 받아쓰고
// 볼트 캡처 한 건으로 정리해 제안한다. 버튼을 한 번 누르면 할 일이나 아이디어로 기록한다.
// 주인은 글을 쓰지 않고 말하고 누르기만 한다. 누르기 전에는 볼트에 아무것도 쓰지 않는다.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Attachment,
  type ButtonInteraction,
  type Message,
  type MessageReplyOptions,
} from "discord.js";
import path from "node:path";
import { redactSensitive } from "../agent/redact.js";
import { clip } from "../daily-log/evidence.js";
import { env } from "../env.js";
import { captureException } from "../observability/sentry.js";
import { findProject, projects } from "../projects.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { cleanCaptureText } from "../vault/editor.js";
import { applyVaultCapture, noteNameForProject } from "../vault/mutations.js";
import { addCapturedVaultTask, getVaultState } from "../vault/state.js";

type Kind = "task" | "idea";

interface VoiceCapture {
  /** 받아쓴 말. */
  transcript: string;
  /** 모델이 제안한 종류. 실제로 기록하는 종류는 누른 버튼이 정한다. */
  kind: Kind;
  /** applyVaultCapture 에 그대로 넘길 프로젝트(카탈로그 slug 또는 허브 노트 이름). 고르지 못했으면 null. */
  project: string | null;
  /** 볼트에 적을 한 문장. */
  text: string;
  createdAt: number;
  /** 버튼으로 끝낸 결과. 있으면 다시 누를 수 없다. */
  outcome?: string;
}

/** 모델의 답. 여기서 project 는 프롬프트에 실은 이름이고, 저장할 때 넘길 값으로 바꾼다. */
type Proposal = Pick<VoiceCapture, "transcript" | "kind" | "project" | "text">;

const FILE = path.resolve(env.WORK_DIR, "..", "voice-captures.json");
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_BYTES = 10 * 1024 * 1024; // base64 로 실어도 Gemini 인라인 요청 한도(20MB) 안에 든다
const MAX_SECONDS = 5 * 60;
const TIMEOUT_MS = 45_000; // 음성 내려받기와 Gemini 호출을 합친 시간
const KEEP_MS = 7 * 86_400_000;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: { type: "STRING" },
    kind: { type: "STRING", enum: ["task", "idea"] },
    project: { type: "STRING", nullable: true },
    text: { type: "STRING" },
  },
  required: ["transcript", "kind", "text"],
  // 받아쓰기를 먼저 적게 해, 정리한 문장이 받아쓴 말에서 나오게 한다.
  propertyOrdering: ["transcript", "kind", "project", "text"],
};

// 처리 중인 캡처. 메모리에만 둔다: 쓰다가 봇이 내려가도 재시작 뒤에 다시 누를 수 있어야 한다.
const busy = new Set<string>();

/** 읽고·고치고·쓰기를 한 틱에 끝낸다. 7일이 지난 캡처는 지워져 그 버튼이 만료된다. */
function update(change: (captures: Record<string, VoiceCapture>) => void): void {
  const captures = readJsonObject<VoiceCapture>(FILE);
  change(captures);
  const oldest = Date.now() - KEEP_MS;
  writeJsonObject(FILE, Object.fromEntries(Object.entries(captures).filter(([, c]) => c.createdAt >= oldest)));
}

/** 인박스 채널에 주인이 올린 음성 메시지나 오디오 첨부. 그 밖의 메시지는 null. */
function voiceAttachment(message: Message): Attachment | null {
  if (!env.INBOX_CHANNEL_ID || message.channelId !== env.INBOX_CHANNEL_ID) return null;
  if (message.author.bot || message.author.id !== env.OWNER_DISCORD_ID) return null;
  const audio = message.attachments.find((file) => file.contentType?.startsWith("audio/"));
  if (audio) return audio;
  return message.flags.has(MessageFlags.IsVoiceMessage) ? (message.attachments.first() ?? null) : null;
}

/**
 * 모델이 고를 프로젝트 이름 → applyVaultCapture 에 넘길 값.
 * 카탈로그 프로젝트는 slug 로, 카탈로그에 없는 볼트 허브는 노트 이름으로 고르게 한다.
 */
function projectChoices(): Map<string, string> {
  // 허브를 모르는 카탈로그 프로젝트는 /task 처럼 slug 를 그대로 넘긴다(프로젝트/<slug>.md).
  const choices = new Map(projects.map((p) => [p.slug, p.slug]));
  for (const hub of getVaultState()?.notes ?? []) {
    // 스냅샷은 허브의 실제 노트 이름을 안다. 할 일은 프로젝트/<노트 이름>.md 에 쓰이므로 노트 이름을 넘기고,
    // slug 가 바로 그 노트를 가리킬 때(프로젝트/ 밖에 있는 이정표·포크레터)만 slug 를 넘긴다.
    const target = hub.slug && noteNameForProject(hub.slug) === hub.note ? hub.slug : hub.note;
    // ponytail: 한 카탈로그 프로젝트로 읽히는 허브가 둘이면 뒤의 것이 그 이름을 차지한다.
    // 그런 볼트가 생기면 앞의 것을 노트 이름으로 따로 싣는다.
    const project = (hub.slug && findProject(hub.slug)) || findProject(hub.note);
    choices.set(project?.slug ?? hub.note, target);
  }
  return choices;
}

function instruction(choices: Map<string, string>): string {
  const listing = [...choices].map(([name, target]) => {
    const project = projects.find((p) => p.slug === name);
    // 말로 부르는 이름: 카탈로그의 이름·별칭과 그 허브의 노트 이름.
    const spoken = new Set([...(project ? [project.name, ...(project.aliases ?? [])] : []), noteNameForProject(target)]);
    spoken.delete(name);
    return spoken.size > 0 ? `${name}(${[...spoken].join("/")})` : name;
  });
  return [
    "첨부한 음성은 한 사람이 자기 할 일·아이디어 노트에 남기려고 말한 한국어 메모다. 받아쓰고 캡처 한 건으로 정리해 JSON 으로 답한다.",
    "- transcript: 들리는 말을 한국어로 그대로 받아쓴다. 요약하거나 고쳐 쓰지 않는다.",
    '- kind: 해야 할 행동이면 "task", 떠오른 생각·제안이면 "idea".',
    "- project: 아래 프로젝트 중 이 메모가 가리키는 것의 이름(괄호 앞부분)을 그대로 적는다. 가리키는 것이 없거나 확실하지 않으면 null.",
    "- text: 캡처할 내용을 추임새(음, 어, 그러니까) 없이 깔끔한 한 문장으로 적는다. 말하지 않은 내용은 지어내지 않는다.",
    "말이 들리지 않으면 transcript 와 text 를 빈 문자열로 둔다.",
    `프로젝트(괄호 안은 부르는 이름): ${listing.join(", ")}`,
  ].join("\n");
}

/**
 * 음성을 Gemini 한 번의 호출로 받아쓰고 캡처 한 건으로 정리한다. 실패하면 한 줄짜리 이유를 던진다.
 * 알아들은 말이 없으면 transcript 나 text 가 빈 문자열이다.
 */
async function transcribe(
  audio: Buffer,
  mimeType: string,
  choices: Map<string, string>,
  signal: AbortSignal,
): Promise<Proposal> {
  const res = await fetch(`${GEMINI_API}/${env.VOICE_MODEL}:generateContent`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: instruction(choices) },
            { inline_data: { mime_type: mimeType, data: audio.toString("base64") } },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  } | null;
  // 본문을 읽다가 시간이 다 된 것은 형식 오류가 아니라 시간 초과다.
  signal.throwIfAborted();
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
  }
  // 생각 요약(thought)이 섞여 오면 뺀다(scripts/content_pipeline.py 와 같다).
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.map((part) => (part.thought ? "" : (part.text ?? ""))).join("");
  let data: Partial<Record<keyof Proposal, unknown>> | null = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // 아래에서 형식 오류로 끝낸다.
  }
  const kind = data?.kind;
  if (kind !== "task" && kind !== "idea") throw new Error("Gemini 응답 형식 오류");
  return {
    transcript: typeof data?.transcript === "string" ? cleanCaptureText(data.transcript, 2000) : "",
    kind,
    project: typeof data?.project === "string" ? data.project : null,
    // 볼트에 적힐 모습 그대로(한 줄, 500자) 보여 주고 저장한다.
    text: typeof data?.text === "string" ? cleanCaptureText(data.text) : "",
  };
}

/** 실패 이유를 문장 속에 넣을 한 줄로. 스택은 싣지 않고 토큰 모양의 값은 가린다. */
function reasonOf(err: unknown): string {
  const reason = !(err instanceof Error)
    ? String(err)
    : err.name === "TimeoutError"
      ? `${TIMEOUT_MS / 1000}초 안에 끝나지 않음`
      : err.message;
  return clip(String(redactSensitive(reason)).replace(/\s+/g, " ").trim().replace(/\.+$/, ""), 200);
}

function captureEmbed(capture: VoiceCapture, result = capture.outcome): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🎙️ 음성 캡처")
    .setDescription(`> ${clip(capture.transcript, 1000)}`)
    .addFields(
      { name: "제안", value: capture.text },
      {
        name: "프로젝트",
        // 프로젝트를 고르지 못한 할 일은 /task 처럼 기본 노트로 간다.
        value: capture.project
          ? noteNameForProject(capture.project)
          : `미지정 (할 일은 ${noteNameForProject(undefined)} 노트로)`,
      },
      ...(result ? [{ name: "결과", value: result }] : []),
    );
}

function captureButtons(id: string, proposed: Kind): ActionRowBuilder<ButtonBuilder> {
  const button = (action: Kind | "drop", label: string) =>
    new ButtonBuilder()
      .setCustomId(`voice:${action}:${id}`)
      .setLabel(label)
      .setStyle(action === proposed ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("task", "✅ 할 일"),
    button("idea", "💡 아이디어"),
    button("drop", "✖ 버림"),
  );
}

/**
 * 인박스 채널의 음성 메시지를 받아써서 캡처를 제안한다. 음성 메시지가 아니면 아무것도 하지 않고 false.
 * 어떤 경우에도 음성 메시지 자체는 건드리지 않고 답장만 단다.
 */
export async function handleVoiceMessage(message: Message): Promise<boolean> {
  const audio = voiceAttachment(message);
  if (!audio) return false;
  // 답장은 보낸 사람에게만 알린다. 제안은 누르기 전까지 볼트에 없으니 자리를 떠도 푸시가 가야 한다.
  const reply = (payload: MessageReplyOptions) =>
    message.reply({ ...payload, allowedMentions: { parse: [], repliedUser: true } });

  if (!env.GEMINI_API_KEY) {
    await reply({ content: "🎙️ 음성 캡처는 꺼져 있습니다 — `GEMINI_API_KEY` 를 설정하면 켜집니다." });
    return true;
  }
  // 길이는 Discord 가 알려 줄 때만 본다(음성 메시지에는 늘 있고, 올린 파일에는 없을 수 있다).
  const over =
    audio.size > MAX_BYTES
      ? `${(audio.size / 1024 / 1024).toFixed(1)}MB`
      : audio.duration !== null && audio.duration > MAX_SECONDS
        ? `${Math.floor(audio.duration / 60)}분 ${Math.round(audio.duration % 60)}초`
        : "";
  if (over) {
    await reply({ content: `🎙️ 음성이 한도를 넘었습니다 (${over}) — 5분·10MB 까지 받습니다. 나눠서 보내 주세요.` });
    return true;
  }

  if ("sendTyping" in message.channel) void message.channel.sendTyping().catch(() => undefined);
  const choices = projectChoices();
  let proposal: Proposal;
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const file = await fetch(audio.url, { signal });
    if (!file.ok) throw new Error(`음성 내려받기 HTTP ${file.status}`);
    // 음성 메시지는 Ogg Opus 다. 종류에 붙은 매개변수(; codecs=…)는 떼고 보낸다.
    const mimeType = (audio.contentType ?? "audio/ogg").split(";")[0].trim();
    proposal = await transcribe(Buffer.from(await file.arrayBuffer()), mimeType, choices, signal);
  } catch (err) {
    console.warn("[voice] transcription failed:", reasonOf(err));
    captureException(err, { kind: "voice-capture" });
    await reply({ content: `⚠️ 받아쓰지 못했습니다 — ${reasonOf(err)}. 음성 메시지는 그대로 있으니 다시 보내 주세요.` });
    return true;
  }
  if (!proposal.transcript || !proposal.text) {
    // 빈 녹음은 장애가 아니다. Sentry 로 보내지 않는다.
    await reply({ content: "🎙️ 알아들은 말이 없습니다 — 다시 말해 주세요." });
    return true;
  }

  // 모델이 slug 대신 부르는 이름(괄호 안)으로 답해도 받는다. 싣지 않은 이름은 미지정으로 둔다.
  const answered = proposal.project ?? "";
  const capture: VoiceCapture = {
    ...proposal,
    project: choices.get(answered) ?? choices.get(findProject(answered)?.slug ?? "") ?? null,
    createdAt: Date.now(),
  };
  // 답장보다 먼저 저장한다: 버튼이 보이는 순간부터, 봇이 재시작한 뒤에도 눌린다.
  update((captures) => {
    captures[message.id] = capture;
  });
  await reply({ embeds: [captureEmbed(capture)], components: [captureButtons(message.id, capture.kind)] });
  return true;
}

/**
 * 제안의 버튼(`voice:<task|idea|drop>:<음성 메시지 id>`): 누른 종류로 볼트에 기록하거나 버리고,
 * 답장에 결과를 적은 뒤 버튼을 뺀다. 기록에 실패하면 이유를 적고 버튼을 남긴다.
 */
export async function handleVoiceButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, id = ""] = interaction.customId.split(":");
  const capture = readJsonObject<VoiceCapture>(FILE)[id];
  if (!capture || (action !== "task" && action !== "idea" && action !== "drop")) {
    await interaction.reply({
      content: "이 음성 캡처는 만료됨 (7일) — 다시 말해 주세요",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (capture.outcome || busy.has(id)) {
    await interaction.reply({
      content: capture.outcome ? `이미 처리한 음성 캡처입니다 — ${capture.outcome}` : "이 음성 캡처를 처리하는 중입니다",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  busy.add(id);
  try {
    // 볼트 커밋·push 는 3초를 넘긴다.
    await interaction.deferUpdate();
    let outcome = "✖ 버렸습니다 — 볼트에 쓰지 않았습니다.";
    if (action !== "drop") {
      try {
        const result = await applyVaultCapture(action, capture.project ?? undefined, capture.text);
        outcome = `${result.changed ? "✅" : "ℹ️"} ${result.summary}`;
      } catch (err) {
        // 원인은 mutation layer 가 이미 Sentry 에 남겼다. 버튼은 그대로 두어 다시 누를 수 있다.
        await interaction.editReply({
          embeds: [captureEmbed(capture, `⚠️ 기록하지 못했습니다 — ${reasonOf(err)}. 다시 눌러 주세요.`)],
        });
        return;
      }
      if (action === "task") {
        // /task 처럼 봇의 스냅샷에도 바로 싣는다. 원본 커밋은 성공했으니 실패해도 다음 맥 동기화가 바로잡는다.
        const slug = capture.project ?? noteNameForProject(undefined);
        await addCapturedVaultTask(noteNameForProject(slug), slug, capture.text).catch((err) =>
          console.warn("[voice] vault snapshot update failed:", err),
        );
      }
    }
    update((captures) => {
      if (captures[id]) captures[id].outcome = outcome;
    });
    await interaction.editReply({ embeds: [captureEmbed(capture, outcome)], components: [] });
  } finally {
    busy.delete(id);
  }
}
