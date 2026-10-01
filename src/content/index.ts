import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type Client, type Message, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "../env.js";
import { JobStore, MAX_GENERATION_ATTEMPTS, type Kind, type Job } from "./store.js";
const execute = promisify(execFile);
let store: JobStore | undefined;
const getStore = () => store ??= new JobStore(join(env.WORK_DIR, "content"));
const enabled = () => process.env.CONTENT_ENABLED === "true";
export function publishReady(kind: Kind, account: string | null): boolean {
  const prefix = kind.toUpperCase();
  const api = process.env[`${prefix}_IG_API`] ?? "facebook";
  return process.env.CONTENT_PUBLISH_ENABLED === "true" && !!account &&
    (api === "facebook" || api === "instagram") &&
    account === process.env[`${prefix}_IG_USER_ID`] && !!process.env[`${prefix}_IG_ACCESS_TOKEN`] &&
    !!process.env.CONTENT_GRAPH_VERSION && !!process.env.CONTENT_S3_BUCKET;
}
const needsWorker = (job: Job): boolean => job.state === "queued" || job.state === "approved" || job.state === "revising" || job.state === "recovering"
  || ((job.state === "review" || job.state === "draft") && !job.message)
  || (["published", "failed", "uncertain"].includes(job.state) && job.message !== `notice:${job.state}`);

/** A top-level owner message in the dedicated channel is one story request. */
export async function contentChannelMessage(message: Message): Promise<boolean> {
  const channel = process.env.INSTATOON_CHANNEL_ID?.trim();
  if (!channel || message.channelId !== channel || !message.guildId || message.author.bot
      || message.author.id !== env.OWNER_DISCORD_ID) return false;
  // Replies and thread discussion are not new paid generation requests.
  if (message.reference || message.channel.isThread() || message.system) return true;
  const reply = (content: string) => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  if (!enabled() || !process.env.GEMINI_API_KEY) {
    await reply("인스타툰 제작 채널입니다. 서버 연결이 완료되면 여기에 스토리와 대사를 한 메시지로 적어 주세요.");
    return true;
  }
  const body = message.content.trim();
  if (!body || body.length > 4000) {
    await reply("스토리와 대사를 텍스트 한 메시지에 적어 주세요. 최대 4,000자이며 첫 줄을 임시 제목으로 사용합니다.");
    return true;
  }
  const jobs = getStore();
  const all = jobs.list();
  if (all.some(job => job.channel === channel && job.sourceMessageId === message.id)) return true;
  if (all.filter(job => ["queued", "generating", "revising", "recovering", "approved", "publishing"].includes(job.state)).length >= 5) {
    await reply("대기 작업이 5개입니다. 처리 후 다시 올려 주세요.");
    return true;
  }
  const topic = body.split(/\r?\n/, 1)[0].slice(0, 100);
  const job = jobs.create("instatoon", topic, body, channel, message.id);
  await reply(`인스타툰 제작을 시작합니다: ${topic}\n완성되면 이 채널에 초안과 캡션을 올립니다. 승인 전에는 게시하지 않습니다.\n작업 ID: ${job.id}`);
  return true;
}

export interface RevisionRequest { panels: number[]; instruction: string; operation: "revise" | "restore" }
/**
 * Only the separate first-line target field selects panels. Numbers in the instruction
 * are reference material, never additional targets. All paid changes need confirmation.
 */
export function parseRevision(text: string, panelCount: number, _failed: number[] = []): RevisionRequest | string {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const match = /^(수정|원복)\s*대상\s*[:：]\s*(.+)$/.exec(header ?? "");
  if (!match) return "첫 줄에 수정 대상을 따로 적어 주세요.\n수정 대상: 6컷\n5컷처럼 노란 과자 봉지를 남겨 주세요.\n원복은 ‘원복 대상: 6컷’으로 요청하세요. 아직 생성 비용은 발생하지 않았습니다.";
  if (!/^(?:\d+\s*(?:컷|번|장)?)(?:\s*[,·]\s*\d+\s*(?:컷|번|장)?)*$/.test(match[2])) return "대상에는 본문 컷 번호만 적어 주세요. 예: 수정 대상: 2, 4컷 (표지 제외)";
  const numbers = match[2].match(/\d+/g)!.map(Number);
  if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > panelCount)) return `컷 번호는 1~${panelCount} 사이여야 합니다 (표지 제외).`;
  const operation = match[1] === "원복" ? "restore" : "revise";
  const instruction = lines.join("\n").trim() || (operation === "restore" ? "지정한 컷을 직전 수정 전 상태로 원복" : "");
  if (!instruction || instruction.length > 1000) return "둘째 줄부터 수정 내용을 1,000자 이내로 적어 주세요.";
  return { panels: [...new Set(numbers.map(n => n - 1))].sort((a, b) => a - b), instruction, operation };
}

/** An owner message inside a job's revision thread re-runs only the named panels. */
export async function contentThreadMessage(message: Message): Promise<boolean> {
  if (!message.channel.isThread() || message.author.bot || message.author.id !== env.OWNER_DISCORD_ID) return false;
  const jobs = getStore();
  const job = jobs.list().find(j => j.thread === message.channelId);
  if (!job) return false;
  const reply = (content: string) => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  if (!enabled() || !process.env.GEMINI_API_KEY) { await reply("생성 API 연결을 확인한 뒤 다시 적어 주세요."); return true; }
  if (["revising", "recovering"].includes(job.state)) { await reply("이전 수정 또는 복구를 처리하는 중입니다. 끝나면 결과를 이 스레드에 올립니다."); return true; }
  if (!["draft", "review"].includes(job.state)) { await reply(`지금 상태(${job.state})에서는 수정 요청을 받을 수 없습니다.`); return true; }
  const dir = jobs.path(job.id);
  const source = existsSync(join(dir, "draft.json")) ? JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) : {};
  const plan = JSON.parse(readFileSync(join(dir, "production-plan.json"), "utf8"));
  const failed: number[] = (source.failed_panels ?? []).map((f: { index: number | null }) => f.index).filter((i: number | null) => Number.isInteger(i));
  const parsed = parseRevision(message.content, plan.panels.length, failed);
  if (typeof parsed === "string") { await reply(parsed); return true; }
  if (jobs.list().filter(j => ["queued", "generating", "revising", "recovering", "approved", "publishing"].includes(j.state)).length >= 5) {
    await reply("대기 작업이 5개입니다. 처리 후 다시 적어 주세요."); return true;
  }
  if (parsed.operation === "restore" && !job.lastRevisionBackup) { await reply("보존된 직전 수정 버전이 없어 자동 원복할 수 없습니다. 기존 결과는 그대로 유지됩니다."); return true; }
  const proposal = jobs.proposeRevision(job.id, { ...parsed, messageId: message.id, backupId: parsed.operation === "restore" ? job.lastRevisionBackup : undefined });
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`content:revise:${job.id}:${proposal.token}`).setLabel(parsed.operation === "restore" ? "이 컷만 원복·재검수" : "이 컷만 수정 시작").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`content:cancel:${job.id}:${proposal.token}`).setLabel("취소").setStyle(ButtonStyle.Secondary));
  await message.reply({ content: `${parsed.operation === "restore" ? "원복" : "수정"} 대상 확인: ${parsed.panels.map(i => `${i + 1}컷`).join(", ")}\n${parsed.instruction.slice(0, 1000)}\n위 컷만 변경합니다. 지시문 속 다른 컷 번호는 참고용입니다.\n아직 실행하지 않았습니다. 확인 버튼을 누르면 생성·재검수 API 비용이 발생하며, 게시에는 별도 승인이 필요합니다.`, components: [buttons], allowedMentions: { parse: [], repliedUser: false } });
  return true;
}

function generationOutcome(dir: string): Pick<Job, "state" | "hash"> {
  if (existsSync(join(dir, "manifest.json"))) {
    return { state: "review", hash: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).hash };
  }
  if (existsSync(join(dir, "draft.json"))) return { state: "draft", hash: undefined };
  throw new Error("worker finished without a manifest or draft");
}

const REVISION_GUIDE = "스레드 첫 줄 ‘수정 대상: 6컷’, 다음 줄에 수정 내용을 적고 대상 확인 버튼을 눌러 주세요. 직전 수정 원복은 ‘원복 대상: 6컷’. 컷 번호는 표지 제외 본문 순서입니다.";

async function ensureThread(job: Job, message: Message): Promise<void> {
  if (job.thread || typeof message.startThread !== "function") return;
  try {
    const thread = await message.startThread({ name: `수정 요청 · ${job.topic}`.slice(0, 100), autoArchiveDuration: 1440 });
    job.thread = thread.id;
  } catch { console.error(`[content] job ${job.id}: revision thread could not be created`); }
}

export async function contentCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (!enabled()) { await i.reply({ content: "콘텐츠 자동화 서버 설정이 필요합니다.", flags: MessageFlags.Ephemeral }); return; }
  const jobs = getStore();
  const id = i.options.getString("job");
  if (id) {
    let j: Job;
    try { j = jobs.get(id); } catch {
      await i.reply({ content: "작업 ID를 찾을 수 없습니다.", flags: MessageFlags.Ephemeral }); return;
    }
    await i.reply({ content: `${j.topic}: ${j.state}\n${j.error ?? j.mediaId ?? ""}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return;
  }
  if (!process.env.GEMINI_API_KEY) {
    await i.reply({ content: "제작 서버는 연결됐습니다. Gemini 생성 키 설정이 완료되면 주제·내용을 접수할 수 있습니다.", flags: MessageFlags.Ephemeral }); return;
  }
  if (!["kind", "topic", "body"].every(key => i.options.getString(key)?.trim())) {
    await i.reply({ content: "제작 요청에는 kind·topic·body를 모두 입력하세요. 상태 확인은 job만 입력하세요.", flags: MessageFlags.Ephemeral }); return;
  }
  const kind = i.options.getString("kind", true) as Kind;
  const topic = i.options.getString("topic", true);
  const body = i.options.getString("body", true);
  if (jobs.list().filter(j => ["queued", "generating", "revising", "recovering", "approved", "publishing"].includes(j.state)).length >= 5) {
    await i.reply({ content: "대기 작업이 5개입니다. 처리 후 다시 요청하세요.", flags: MessageFlags.Ephemeral }); return;
  }
  const job = jobs.create(kind, topic, body, i.channelId);
  await i.reply({ content: `제작 접수: ${topic}\n작업 ID: ${job.id}\n생성·자동 검수가 끝나면 이 채널에 승인 요청을 보냅니다.`, allowedMentions: { parse: [] } });
}
export async function contentButton(i: ButtonInteraction): Promise<void> {
  const [, action, id, hash] = i.customId.split(":");
  if (!enabled() || !["approve", "reject", "retry", "revise", "cancel"].includes(action)) throw new Error("콘텐츠 기능 비활성 또는 잘못된 버튼");
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // State transitions are authoritative. Discord notification failures must not
  // falsely report a rejected request after paid work/publication was accepted.
  const acknowledge = async (content: string) => {
    try { await i.editReply(content); }
    catch { console.error(`[content] job ${id}: accepted action reply failed`); }
    try { await i.message.edit({ components: [] }); }
    catch { console.error(`[content] job ${id}: stale buttons could not be removed`); }
  };
  try {
    const candidate = getStore().get(id);
    if (![candidate.channel, candidate.thread].includes(i.channelId)) throw new Error("다른 작업의 채널입니다");
    if (action === "revise" || action === "cancel") {
      if (action === "revise" && !process.env.GEMINI_API_KEY) { await i.editReply("생성 API 연결을 확인한 뒤 다시 눌러 주세요."); return; }
      getStore().confirmRevision(id, hash, action === "cancel");
      await acknowledge(action === "cancel" ? "수정 요청을 취소했습니다. 비용은 발생하지 않았습니다." : "확인한 컷만 처리합니다. 결과와 전후 비교를 스레드에 올리며, 자동 게시하지 않습니다.");
      return;
    }
    if (action === "retry") {
      if (!process.env.GEMINI_API_KEY) {
        await i.editReply("생성 API 연결을 확인한 뒤 다시 눌러 주세요."); return;
      }
      const job = getStore().retry(id, i.channelId);
      await acknowledge(`같은 이야기로 새 초안을 제작합니다. 새 생성에는 API 비용이 발생합니다.\n작업: ${job.id}\n기존 실패 결과는 보존되며, 게시에는 별도 승인이 필요합니다.`);
      return;
    }
    if (action === "approve") {
      const manifest = JSON.parse(readFileSync(join(getStore().path(id), "manifest.json"), "utf8"));
      if (!publishReady(candidate.kind, manifest.account)) {
        await i.editReply("Instagram 계정 연결 전에는 미리보기 검토만 가능합니다. 게시 설정 후 새 승인 요청이 필요합니다."); return;
      }
    }
    // Restoring identical media must not reactivate an old Discord approval button.
    if (candidate.message !== i.message.id) throw new Error("이전 검토 메시지입니다");
    const job = getStore().decide(id, hash, action === "approve");
    await acknowledge(job.state === "approved" ? "승인했습니다. 게시 결과를 이 채널로 안내합니다." : "반려했습니다. 수정 내용을 넣어 다시 제작 요청하세요.");
  } catch { await i.editReply(action === "retry" ? "다시 제작할 수 없습니다. 실패한 작업인지, 원래 채널 또는 해당 수정 스레드인지, 대기 작업이 5개 이상인지 확인하세요."
    : ["revise", "cancel"].includes(action) ? "만료됐거나 처리할 수 없는 수정 요청입니다. 최신 요청인지, 대기 작업이 5개 이상인지 확인하세요."
    : "이미 처리됐거나 만료된 승인 요청입니다. 최신 검토 메시지에서 확인하세요."); }
}
async function runWorker(job: Job, action: string): Promise<void> {
  await execute(process.env.CONTENT_PYTHON ?? "python3", [resolve("scripts/content_pipeline.py"), action, getStore().path(job.id)],
    { timeout: 45 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
}
export function startContentWorker(client: Client): void {
  if (!enabled()) return;
  const jobs = getStore(); jobs.recover();
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      for (const job of jobs.list()) {
        if (!needsWorker(job)) continue;
        try {
          const channel = await client.channels.fetch(job.channel);
          if (!channel?.isSendable()) continue;
          const send = (content: string) => channel.send({ content, allowedMentions: { parse: [] } });
          if (job.state === "queued" || job.state === "approved" || job.state === "revising" || job.state === "recovering") {
            const publishing = job.state === "approved";
            const revising = job.state === "revising";
            const recovering = job.state === "recovering";
            if (publishing && !publishReady(job.kind, JSON.parse(readFileSync(join(jobs.path(job.id), "manifest.json"), "utf8")).account)) {
              job.state = "review"; job.approvedHash = undefined; job.message = undefined; jobs.save(job);
              continue;
            }
            if (!publishing && !revising && !recovering) job.generationAttempts = (job.generationAttempts ?? 0) + 1;
            job.error = undefined;
            job.state = publishing ? "publishing" : revising ? "revising" : recovering ? "recovering" : "generating"; jobs.save(job);
            try {
              await runWorker(job, publishing ? "publish" : revising ? "revise" : recovering ? "recover-revision" : "generate");
              if (publishing) {
                const receipt = JSON.parse(readFileSync(join(jobs.path(job.id), "receipt.json"), "utf8"));
                job.mediaId = receipt.id; job.state = "published";
              } else {
                // The worker ends in a publishable manifest or an operator draft with flagged panels.
                Object.assign(job, generationOutcome(jobs.path(job.id)));
                job.message = undefined; job.revisionFrom = undefined;
                if (revising) {
                  const result = JSON.parse(readFileSync(join(jobs.path(job.id), "revision-result.json"), "utf8"));
                  if (result.backupId !== job.revisionId) throw new Error("Missing revision checkpoint");
                  job.lastRevisionBackup = result.backupId;
                }
                job.revisionId = undefined;
                if (recovering) job.error = "수정 실패 또는 중단으로 수정 전 결과를 복구했습니다. 아래 결과를 다시 확인해 주세요.";
              }
            } catch (error) {
              if (revising) {
                job.state = "recovering"; job.hash = undefined; job.approvedHash = undefined;
                job.error = "수정 실패. 수정 전 결과를 복구한 뒤 새 검토 요청을 보냅니다.";
              } else if (recovering) {
                job.state = "failed"; job.hash = undefined; job.approvedHash = undefined;
                job.error = "수정 전 결과의 안전한 복구에 실패했습니다. 게시하지 않습니다. 보존된 스냅샷을 운영자가 확인해야 합니다.";
              } else {
                const retryable = !publishing && typeof error === "object" && error !== null
                  && "code" in error && error.code === 75 && job.generationAttempts! < MAX_GENERATION_ATTEMPTS;
                job.state = publishing ? "uncertain" : retryable ? "queued" : "failed";
                job.error = publishing ? "게시 결과 확인 필요: 자동 재게시하지 않습니다. 서버의 receipt.json/publish-attempt.json을 확인하세요."
                  : retryable ? `일시적 생성 오류. 저장된 단계부터 자동 재시도합니다 (${job.generationAttempts}/${MAX_GENERATION_ATTEMPTS}).`
                  : "생성·검수 실패. 서버 error.json을 확인한 뒤 수정 요청하세요.";
              }
            }
            jobs.save(job);
          }
          if ((job.state === "review" || job.state === "draft") && !job.message) {
            // Revised episodes report inside their thread so the conversation stays in one place.
            const thread = job.thread ? await client.channels.fetch(job.thread).catch(() => null) : null;
            const target = thread?.isSendable() ? thread : channel;
            const dir = jobs.path(job.id);
            const guide = (job.error ? `\n${job.error}` : "") + (job.kind === "instatoon" ? `\n${REVISION_GUIDE}` : "");
            // Discord allows at most ten attachments per message. Keep the final
            // approval message last, after all comparison/review documents arrive.
            const documents = ["comparison.html", "review.html"].filter(name => existsSync(join(dir, name)));
            if (documents.length) await target.send({ content: "검토 자료 · comparison.html은 수정 전후 비교입니다.",
              files: documents.map(name => ({ attachment: join(dir, name), name })), allowedMentions: { parse: [] } });
            let message: Message;
            if (job.state === "review") {
              const result = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
              const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`content:approve:${job.id}:${job.hash}`).setLabel(publishReady(job.kind, result.account) ? "승인하고 게시" : "계정 연결 후 게시 가능").setDisabled(!publishReady(job.kind, result.account)).setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`content:reject:${job.id}:${job.hash}`).setLabel("반려").setStyle(ButtonStyle.Danger));
              message = await target.send({ content: `검토 요청: ${job.topic}\n게시 대상 계정 ID: ${result.account ?? "미연결 · 제작/검토 전용"}\n${result.caption}\n자동 검수: ${result.review.summary}${guide}\n작업: ${job.id}`.slice(0, 1900),
                files: result.previews.map((p: string) => ({ attachment: join(dir, p), name: p })),
                components: [buttons], allowedMentions: { parse: [] } });
            } else {
              const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));
              const failed = (draft.failed_panels ?? []) as { index: number | null; blockers?: string[]; error?: string }[];
              const lines = failed.map(f => `${Number.isInteger(f.index) ? `${(f.index as number) + 1}컷` : "전체"}: ${(f.blockers ?? []).join(" / ") || f.error || "검수 실패"}`);
              if (!lines.length && draft.final_review?.blockers?.length) lines.push(`전체: ${draft.final_review.blockers.join(" / ")}`);
              const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`content:retry:${job.id}`).setLabel("같은 이야기 처음부터 다시").setStyle(ButtonStyle.Secondary));
              message = await target.send({ content: `초안(게시 불가): ${job.topic}\n자동 검수를 통과하지 못한 컷이 있습니다.\n${lines.join("\n")}\n${draft.caption ?? ""}${guide}\n작업: ${job.id}`.slice(0, 1900),
                files: (draft.previews ?? []).map((p: string) => ({ attachment: join(dir, p), name: p })),
                components: [retry], allowedMentions: { parse: [] } });
            }
            const latest = jobs.get(job.id);
            latest.message = message.id; latest.thread = job.thread;
            if (job.kind === "instatoon") await ensureThread(latest, message);
            jobs.save(latest);
          }
          if (["published", "failed", "uncertain"].includes(job.state) && job.message !== `notice:${job.state}`) {
            const notice = `${job.topic}: ${job.state}\n${job.error ?? `게시 완료 · Instagram 미디어 ID ${job.mediaId}`}\n작업: ${job.id}`;
            if (job.kind === "instatoon" && job.state === "failed") {
              const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`content:retry:${job.id}`).setLabel("같은 이야기 다시 제작").setStyle(ButtonStyle.Primary));
              await channel.send({ content: `${notice}\n같은 이야기로 새 초안을 다시 생성할 수 있습니다. 다시 제작하면 API 비용이 발생합니다.`,
                components: [retry], allowedMentions: { parse: [] } });
            } else {
              await send(notice);
            }
            job.message = `notice:${job.state}`; jobs.save(job);
          }
        } catch {
          console.error(`[content] job ${job.id} worker/notification failed; retrying next tick`);
        }
      }
    } catch { console.error("[content] worker/notification failed; retrying next tick"); }
    finally { busy = false; }
  };
  void tick(); setInterval(() => void tick(), 10_000).unref();
}
