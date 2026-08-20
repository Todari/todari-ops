import { describe, expect, it } from "vitest";
import { buildInstagramMessage, normalizeInstagramEvent } from "./instagram-handler.js";

const validPayload = {
  account: "jakkuyagu",
  media_id: "17890000000000000",
  permalink: "https://www.instagram.com/p/example/",
  caption: "오늘 경기 프리뷰",
  content_type: "preview",
  source_key: "2026-08-20:preview:game-1",
  published_at: "2026-08-20T12:34:56+09:00",
};

describe("Instagram webhook event", () => {
  it("normalizes a signed publisher payload and builds a linked embed", () => {
    const event = normalizeInstagramEvent(validPayload);
    expect(event).not.toBeNull();
    const message = buildInstagramMessage(event!);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;

    expect(json).toMatchObject({
      title: "자꾸야구 게시물 업로드 완료",
      url: validPayload.permalink,
      description: validPayload.caption,
    });
    expect(message.components).toHaveLength(1);
  });

  it("rejects unknown accounts and non-Instagram links", () => {
    expect(normalizeInstagramEvent({ ...validPayload, account: "unknown" })).toBeNull();
    expect(
      normalizeInstagramEvent({ ...validPayload, permalink: "https://example.com/phishing" }),
    ).toBeNull();
  });

  it("allows a notification when permalink lookup was unavailable", () => {
    const event = normalizeInstagramEvent({ ...validPayload, permalink: null });
    expect(event?.permalink).toBeNull();
    expect(buildInstagramMessage(event!).components).toBeUndefined();
  });
});
