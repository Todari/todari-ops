import { EmbedBuilder, type ThreadChannel } from "discord.js";

// Best-effort renderer. The exact SDK message shape may vary across versions —
// we duck-type. Unknown shapes are silently ignored to avoid noise.
interface MaybeContent {
  type?: string;
  text?: string;
}

interface MaybeMessage {
  type?: string;
  subtype?: string;
  message?: { content?: unknown };
  result?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  session_id?: string;
}

const MAX = 1900;

export async function renderEvent(thread: ThreadChannel, event: unknown): Promise<void> {
  const e = event as MaybeMessage;

  // SDK emits both `assistant` and `result` for the same final text — we
  // render assistant only to avoid double-posting. `result` is still
  // consumed by run.ts for session_id extraction.
  if (e.type === "result") return;

  // Assistant text/content
  if (e.type === "assistant" && e.message?.content) {
    const text = extractText(e.message.content);
    if (text) await sendChunked(thread, text);
    // Also detect tool_use embedded in content blocks
    if (Array.isArray(e.message.content)) {
      for (const block of e.message.content as MaybeContent[]) {
        if ((block as { type?: string }).type === "tool_use") {
          const b = block as unknown as { name?: string; input?: unknown };
          await renderToolUse(thread, b.name ?? "tool", b.input);
        }
      }
    }
    return;
  }

  // Standalone tool use event (some SDK versions)
  if (e.type === "tool_use") {
    await renderToolUse(thread, e.name ?? "tool", e.input);
    return;
  }

  // Tool result
  if (e.type === "tool_result" || e.type === "user") {
    const text = extractText(e.message?.content ?? e.content);
    if (text) {
      const embed = new EmbedBuilder()
        .setColor(0x34d399)
        .setDescription(
          "```\n" +
            text.slice(0, 1500) +
            (text.length > 1500 ? "\n…(truncated)" : "") +
            "\n```",
        );
      await thread.send({ embeds: [embed] });
    }
    return;
  }

  // Init / system events ignored
}

async function renderToolUse(thread: ThreadChannel, name: string, input: unknown): Promise<void> {
  const inputStr = input ? JSON.stringify(input).slice(0, 400) : "";
  const embed = new EmbedBuilder()
    .setColor(0x60a5fa)
    .setDescription(
      `🔧 **${name}**` + (inputStr ? `\n\`${inputStr}\`` : ""),
    );
  await thread.send({ embeds: [embed] });
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as MaybeContent[])
      .map((c) => (typeof c === "string" ? c : (c.text ?? "")))
      .join("");
  }
  if (content && typeof content === "object") {
    return (content as MaybeContent).text ?? "";
  }
  return "";
}

async function sendChunked(thread: ThreadChannel, text: string): Promise<void> {
  if (text.length <= MAX) {
    await thread.send(text);
    return;
  }
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > MAX) {
      if (buf) await thread.send(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) await thread.send(buf);
}
