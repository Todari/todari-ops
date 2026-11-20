import type { MessageCreateOptions } from "discord.js";

/** The Mac sweeper also understands this envelope. Keep the original UTF-8 text in one message. */
export function inboxCapturePayload(content: string): MessageCreateOptions {
  const allowedMentions = { parse: [] };
  if (content.length <= 2000) return { content, allowedMentions };
  const body = Buffer.from(content, "utf8");
  if (body.length > 1024 * 1024) throw new Error("인박스 첨부는 최대 1 MiB입니다");
  return {
    content: "📥 [file] inbox-capture.txt",
    files: [{ attachment: body, name: "inbox-capture.txt" }],
    allowedMentions,
  };
}
