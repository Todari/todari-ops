import { MessageFlags } from "discord.js";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  acknowledgeProblem,
  applyProblemResults,
  buildInstagramMessage,
  handleInstagramEvent,
  normalizeInstagramEvent,
  pendingProblemRequests,
  requestProblemAction,
} from "./instagram-handler.js";

const mocks = vi.hoisted(() => {
  let nextId = 0;
  // 채널이 돌려주는 메시지: 문제 메시지 저장소가 위치(channelId·id)를 기억했다가 고친다.
  const sender = (channelId: string) => vi.fn(async (_message: any) => ({ id: `m${++nextId}`, channelId }));
  return {
    // 문제 메시지 저장소가 WORK_DIR 옆에 파일을 쓴다.
    env: { OWNER_DISCORD_ID: "owner", WORK_DIR: `${process.env.TMPDIR ?? "/tmp"}/ig-handler-test-${process.pid}/work` },
    send: sender("log"),
    alertsSend: sender("alerts"),
    digestSend: sender("digest"),
    fetchMessage: vi.fn(),
    deleteMessage: vi.fn(async (_id: string) => {}),
  };
});
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchInstagramChannel: async () => ({ send: mocks.send }),
  fetchAlertsChannel: async () => ({ send: mocks.alertsSend }),
  fetchDigestChannel: async () => ({ send: mocks.digestSend }),
  fetchTextChannel: async () => ({ messages: { fetch: mocks.fetchMessage, delete: mocks.deleteMessage } }),
}));
afterAll(() => rmSync(dirname(mocks.env.WORK_DIR), { recursive: true, force: true }));

const validPayload = {
  account: "jakkuyagu",
  media_id: "17890000000000000",
  permalink: "https://www.instagram.com/p/example/",
  preview_url: "https://bucket.s3.ap-northeast-2.amazonaws.com/preview.png?signature=test",
  caption: "오늘 경기 프리뷰\n선발 라인업과 관전 포인트를 확인하세요.",
  content_type: "preview",
  source_key: "2026-08-20:preview:game-1",
  quality_review: {
    audience: "baseball_fan",
    overall_score: 84,
    scores: {
      factual_trust: 95,
      information_density: 78,
      game_story: 82,
      fan_interest: 83,
      natural_voice: 80,
      visual_delivery: 86,
    },
    summary: "경기 흐름이 잘 보이지만 한 장면의 맥락은 더 보강할 수 있습니다.",
    strengths: ["득점 전후 점수가 명확합니다."],
    improvements: ["투수 교체 뒤 흐름을 한 문장 더 연결하세요."],
  },
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
      title: "새 게시물 · 오늘 경기 프리뷰",
      url: validPayload.permalink,
      description: "선발 라인업과 관전 포인트를 확인하세요.",
      image: { url: validPayload.preview_url },
    });
    expect(message.components).toHaveLength(1);
    expect(json).toMatchObject({ author: { name: "야있날 @yaitnal" } });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "야구팬 관점 품질 점수" }),
        expect.objectContaining({ name: "다음 생성에서 개선" }),
      ]),
    );
    const row = message.components?.[0];
    const rowJson = row && "toJSON" in row ? row.toJSON() : row;
    expect(rowJson).toMatchObject({
      components: [
        {
          label: "게시물 바로 보기",
          url: validPayload.permalink,
        },
      ],
    });
  });

  it("rejects unknown accounts and non-Instagram links", () => {
    expect(normalizeInstagramEvent({ ...validPayload, account: "unknown" })).toBeNull();
    expect(
      normalizeInstagramEvent({ ...validPayload, permalink: "https://example.com/phishing" }),
    ).toBeNull();
  });

  it("allows a notification when permalink lookup was unavailable", () => {
    const event = normalizeInstagramEvent({ ...validPayload, permalink: null });
    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    expect(event.permalink).toBeNull();
    expect(buildInstagramMessage(event!).components).toHaveLength(1);
  });

  it("keeps compatibility with publishers that have no fan review yet", () => {
    const event = normalizeInstagramEvent({ ...validPayload, quality_review: null });
    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    expect(event.qualityReview).toBeNull();
  });

  it("accepts an approved quality review with no improvements", () => {
    const event = normalizeInstagramEvent({
      ...validPayload,
      account: "sector4",
      quality_review: {
        audience: "f1_fan",
        overall_score: 94,
        scores: { factual_trust: 95, fan_interest: 94 },
        summary: "사실과 레이스 맥락을 충분히 전달했습니다.",
        strengths: ["전체 순위와 주요 변화를 함께 보여줍니다."],
        improvements: [],
      },
    });

    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "다음 생성에서 개선",
          value: "승인 기준에서 추가 개선점 없음",
        }),
      ]),
    );
  });

  it("accepts jujinmo reel publishes with its own series labels", () => {
    const event = normalizeInstagramEvent({
      account: "jujinmo",
      media_id: "17890000000000001",
      permalink: "https://www.instagram.com/reel/example/",
      caption: "장전 한 장\n오늘 장에서 먼저 볼 세 가지.\n특정 종목의 매수·매도를 권유하지 않습니다.",
      content_type: "premarket_preview",
      source_key: "2026-08-25-premarket",
      quality_review: null,
      published_at: "2026-08-25T08:05:00+09:00",
    });
    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ author: { name: "주진모? @ju.jin.mo" } });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "게시물 유형", value: "장전 한 장" }),
      ]),
    );
  });

  it("accepts a stock-reader quality review for jujinmo", () => {
    const event = normalizeInstagramEvent({
      ...validPayload,
      account: "jujinmo",
      content_type: "premarket_hypothesis",
      quality_review: {
        ...validPayload.quality_review,
        audience: "stock_reader",
      },
    });

    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    expect(event.qualityReview?.audience).toBe("stock_reader");
    const embed = buildInstagramMessage(event).embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "주식 독자 관점 품질 점수" }),
        expect.objectContaining({ name: "게시물 유형", value: "장전 근거 분석" }),
      ]),
    );
  });

  it("normalizes gonggu publishes and builds the account embed", () => {
    const event = normalizeInstagramEvent({
      account: "gonggu",
      media_id: "17890000000000002",
      permalink: "https://www.instagram.com/p/gonggu-example/",
      caption: "오늘의 공동구매\n마감 전에 확인할 상품을 모았습니다.",
      content_type: "gonggu-daily",
      source_key: "2026-09-04",
      quality_review: null,
      published_at: "2026-09-04T10:35:00+09:00",
    });

    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    const embed = buildInstagramMessage(event).embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ author: { name: "공구함 @09._.ham" } });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "게시물 유형", value: "공구 일일 다이제스트" }),
      ]),
    );
  });

  it("normalizes gonggu failures and builds the account embed", () => {
    const event = normalizeInstagramEvent({
      account: "gonggu",
      status: "failed",
      error_type: "RuntimeError",
      error_message: "공구 게시 실패",
      content_type: "gonggu-daily",
      source_key: "2026-09-04",
      stage: "media_publish",
      failure_category: "api_error",
      attempt: 1,
      next_retry_at: null,
      occurred_at: "2026-09-04T10:40:00+09:00",
    });

    expect(event?.status).toBe("failed");
    if (!event || event.status !== "failed") throw new Error("expected failure event");
    const embed = buildInstagramMessage(event).embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({
      title: "공구함 자동 게시 실패",
      author: { name: "공구함 @09._.ham" },
    });
  });

  it("builds a red embed for jujinmo scheduled failures", () => {
    const event = normalizeInstagramEvent({
      account: "jujinmo",
      status: "failed",
      error_type: "RuntimeError",
      error_message: "게시 설정 미완료: IG_ACCESS_TOKEN",
      content_type: "close_review",
      source_key: "2026-08-25-close",
      stage: "scheduler_preflight",
      failure_category: "configuration",
      attempt: 1,
      next_retry_at: null,
      occurred_at: "2026-08-25T16:20:00+09:00",
    });
    expect(event?.status).toBe("failed");
    if (!event || event.status !== "failed") throw new Error("expected failure event");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ title: "주진모? 자동 게시 실패" });
  });

  it("rejects non-HTTPS preview images", () => {
    expect(
      normalizeInstagramEvent({ ...validPayload, preview_url: "http://example.com/preview.png" }),
    ).toBeNull();
  });

  it("builds an actionable red embed for a sanitized publish failure", () => {
    const event = normalizeInstagramEvent({
      account: "sector4",
      status: "failed",
      error_type: "RuntimeError",
      error_message: "Instagram Graph API 오류(400): token expired",
      content_type: "sector4-poller",
      source_key: "result-2026-r13",
      stage: "media_publish",
      failure_category: "ambiguous_publish",
      attempt: 2,
      next_retry_at: "2026-08-20T15:00:00+09:00",
      occurred_at: "2026-08-20T14:45:00+09:00",
    });
    expect(event).not.toBeNull();

    const message = buildInstagramMessage(event!);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({
      color: 0xed4245,
      title: "섹터4 자동 게시 실패",
      description: "Instagram Graph API 오류(400): token expired",
      author: { name: "섹터4 @sector4.f1" },
    });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "게시물 유형", value: "섹터4 스케줄러" }),
        expect.objectContaining({ name: "실패 지점", value: "Instagram 최종 게시" }),
        expect.objectContaining({ name: "원인 분류", value: "게시 응답 불명확 · 중복 대조 필요" }),
        expect.objectContaining({ name: "누적 시도", value: "2회" }),
        expect.objectContaining({ name: "대상", value: "`result-2026-r13`" }),
      ]),
    );
  });

  it("rejects malformed failure events", () => {
    expect(
      normalizeInstagramEvent({
        account: "jakkuyagu",
        status: "failed",
        error_type: "RuntimeError",
        error_message: "",
        occurred_at: "not-a-date",
      }),
    ).toBeNull();
  });
});

describe("portfolio digest events", () => {
  it("renders a digest embed without account whitelist", () => {
    const event = normalizeInstagramEvent({
      status: "digest",
      title: "주간 인스타 리포트 · 8월 5주",
      body: "야있날 11→13 팔로워\n섹터4 5→6 팔로워",
    });
    expect(event?.status).toBe("digest");
    if (!event || event.status !== "digest") throw new Error("expected digest");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ title: "주간 인스타 리포트 · 8월 5주" });
  });

  it("rejects digest without title or body", () => {
    expect(normalizeInstagramEvent({ status: "digest", title: "", body: "x" })).toBeNull();
    expect(normalizeInstagramEvent({ status: "digest", title: "t" })).toBeNull();
  });
});

describe("watchdog alert levels", () => {
  // 워치독은 단계와 무관하게 같은 stage·failure_category를 보낸다.
  const watchdogPayload = {
    account: "jakkuyagu",
    status: "failed",
    error_type: "PublishWatchdog",
    error_message: "프리뷰 게시가 예정 시각보다 25분 늦었습니다.",
    content_type: "preview",
    source_key: "2026-10-09:preview:game-1",
    stage: "publish_watchdog",
    failure_category: "watchdog",
    occurred_at: "2026-10-09T17:55:00+09:00",
  };

  it("routes action levels to the alerts channel, digests to the digest channel, the rest to the log", async () => {
    for (const mock of [mocks.send, mocks.alertsSend, mocks.digestSend]) mock.mockClear();
    const deliver = (alert_level: string, source_key: string) =>
      handleInstagramEvent(normalizeInstagramEvent({ ...watchdogPayload, alert_level, source_key })!);

    for (const level of ["delay", "recovered", "action", "outage", "outage_resolved", "outage_closed"]) {
      expect(await deliver(level, `routing:${level}`)).toBe(true);
    }
    expect(
      await handleInstagramEvent(
        normalizeInstagramEvent({ status: "digest", title: "인스타 게시 실적 · routing", body: "어제 게시: 1/3건" })!,
      ),
    ).toBe(true);

    const titles = (mock: typeof mocks.send) =>
      mock.mock.calls.map(([message]) => message.embeds[0].toJSON().title);
    expect(titles(mocks.send)).toEqual(["야있날 게시 지연 · 자동 복구 중", "야있날 지연 게시 완료"]);
    expect(titles(mocks.alertsSend)).toEqual([
      "야있날 운영자 확인 필요",
      "야있날 게시 중단",
      "야있날 게시 재개",
      "야있날 게시 중단 종료 · 새 예정 없음",
    ]);
    expect(mocks.digestSend).toHaveBeenCalledTimes(1);
  });

  it("closes a problem by editing its first message, across a restart, instead of posting again", async () => {
    for (const mock of [mocks.send, mocks.alertsSend, mocks.fetchMessage]) mock.mockClear();
    const edit = vi.fn();
    const original = (alert_level: string) => ({
      ...buildInstagramMessage(normalizeInstagramEvent({ ...watchdogPayload, alert_level })!),
      edit,
    });
    const deliver = async (alert_level: string, source_key: string, handle = handleInstagramEvent) =>
      handle(normalizeInstagramEvent({ ...watchdogPayload, alert_level, source_key, error_message: `${alert_level} 문구` })!);

    // 지연 → 지연 게시 완료: 로그 채널의 지연 메시지를 고친다.
    await deliver("delay", "one:late");
    mocks.fetchMessage.mockResolvedValueOnce(original("delay"));
    expect(await deliver("recovered", "one:late")).toBe(true);
    // 중단 → (봇 재시작) → 재개: 조치 채널의 중단 메시지를 고치고 멘션을 지운다.
    await deliver("outage", "one:outage");
    vi.resetModules();
    const restarted = (await import("./instagram-handler.js")).handleInstagramEvent;
    mocks.fetchMessage.mockResolvedValueOnce(original("outage"));
    expect(await deliver("outage_resolved", "one:outage", restarted)).toBe(true);

    expect([mocks.send.mock.calls.length, mocks.alertsSend.mock.calls.length]).toEqual([1, 1]);
    const sentIds = await Promise.all(
      [mocks.send, mocks.alertsSend].map(async (mock) => (await mock.mock.results[0]!.value).id),
    );
    expect(mocks.fetchMessage.mock.calls.map(([id]) => id)).toEqual(sentIds);
    const edits = edit.mock.calls.map(([message]) => ({ content: message.content, ...message.embeds[0].toJSON() }));
    // 닫힌 메시지에는 "확인함" 줄이 남지 않는다(계정 링크 줄만 남는다).
    expect(edit.mock.calls.map(([message]) => message.components.length)).toEqual([1, 1]);
    expect(edits).toMatchObject([
      { content: null, title: "야있날 지연 게시 완료", color: 0x57f287, description: watchdogPayload.error_message },
      { content: null, title: "야있날 게시 재개", color: 0x57f287, description: watchdogPayload.error_message },
    ]);
    expect(edits.map((embed) => embed.fields.at(-1))).toMatchObject([
      { name: "닫힘", value: expect.stringContaining("recovered 문구") },
      { name: "닫힘", value: expect.stringContaining("outage_resolved 문구") },
    ]);

    // 닫힌 문제는 기록에서 빠진다. 같은 키의 다음 닫는 알림은 새 메시지로 간다.
    mocks.fetchMessage.mockClear();
    expect(await deliver("outage_closed", "one:outage", restarted)).toBe(true);
    expect([mocks.fetchMessage.mock.calls.length, mocks.alertsSend.mock.calls.length]).toEqual([0, 2]);
  });

  it("re-alerts by replacing the first message, and stays quiet once the owner acknowledged it", async () => {
    for (const mock of [mocks.alertsSend, mocks.deleteMessage]) mock.mockClear();
    vi.useFakeTimers({ now: Date.parse("2026-10-09T09:37:00+09:00") });
    const remind = () =>
      handleInstagramEvent(
        normalizeInstagramEvent({ ...watchdogPayload, alert_level: "outage", source_key: "ack:outage" })!,
      );
    const sentId = async (index: number) => (await mocks.alertsSend.mock.results[index]!.value).id;

    expect(await remind()).toBe(true);
    const first = mocks.alertsSend.mock.calls[0]![0];
    expect(first.components.map((row: { toJSON(): unknown }) => row.toJSON())).toMatchObject([
      { components: [{ label: "Instagram 계정 확인" }] },
      { components: [{ custom_id: "igack", label: "확인함" }] },
    ]);
    // 사흘 뒤 다시 알림: 새 메시지를 올리고 먼저 올린 것은 지운다.
    vi.advanceTimersByTime(3 * 86_400_000);
    expect(await remind()).toBe(true);
    expect(mocks.deleteMessage.mock.calls).toEqual([[await sentId(0)]]);

    // "확인함"을 누르면 회색으로 바뀌고 멘션과 버튼 줄이 사라진다. 이후 다시 알림은 보내지 않는다.
    const update = vi.fn();
    await acknowledgeProblem({ message: { id: await sentId(1), ...first }, update } as never);
    expect(update.mock.calls[0]![0]).toMatchObject({ content: null, components: [first.components[0]] });
    expect(update.mock.calls[0]![0].embeds[0].toJSON()).toMatchObject({
      color: 0x95a5a6,
      fields: expect.arrayContaining([{ name: "확인함", value: expect.stringContaining("다시 알리지 않습니다") }]),
    });
    vi.advanceTimersByTime(3 * 86_400_000);
    expect(await remind()).toBe(false);
    expect(mocks.alertsSend).toHaveBeenCalledTimes(2);

    // 닫는 알림은 확인한 문제에도 그대로 적용된다.
    const edit = vi.fn();
    mocks.fetchMessage.mockResolvedValueOnce({ ...first, edit });
    expect(
      await handleInstagramEvent(
        normalizeInstagramEvent({ ...watchdogPayload, alert_level: "outage_resolved", source_key: "ack:outage" })!,
      ),
    ).toBe(true);
    expect(edit.mock.calls[0]![0].embeds[0].toJSON().title).toBe("야있날 게시 재개");
    vi.useRealTimers();
  });

  it("posts the closing alert as a new message when the first one is gone", async () => {
    for (const mock of [mocks.send, mocks.fetchMessage]) mock.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deliver = (alert_level: string) =>
      handleInstagramEvent(normalizeInstagramEvent({ ...watchdogPayload, alert_level, source_key: "gone:late" })!);
    await deliver("delay");
    mocks.fetchMessage.mockRejectedValueOnce(new Error("Unknown Message"));
    expect(await deliver("recovered")).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("delivers each alert level of the same job once", async () => {
    mocks.send.mockClear();
    const deliver = (alert_level?: string) =>
      handleInstagramEvent(normalizeInstagramEvent({ ...watchdogPayload, alert_level })!);

    expect(await deliver("delay")).toBe(true);
    expect(await deliver("delay")).toBe(false);
    expect(await deliver("recovered")).toBe(true);
    // alert_level이 없거나 모르는 값이면 기존 키 하나를 같이 쓴다.
    expect(await deliver()).toBe(true);
    expect(await deliver("urgent")).toBe(false);

    expect(mocks.send.mock.calls.map(([message]) => message.embeds[0].toJSON().title)).toEqual([
      "야있날 게시 지연 · 자동 복구 중",
      "야있날 지연 게시 완료",
      "야있날 자동 게시 실패",
    ]);
  });

  it.each([
    ["delay", 0xfee75c, "야있날 게시 지연 · 자동 복구 중", true, false],
    ["recovered", 0x57f287, "야있날 지연 게시 완료", true, false],
    ["action", 0xed4245, "야있날 운영자 확인 필요", false, true],
    ["outage", 0xed4245, "야있날 게시 중단", false, true],
    ["outage_resolved", 0x57f287, "야있날 게시 재개", false, false],
    ["outage_closed", 0x95a5a6, "야있날 게시 중단 종료 · 새 예정 없음", true, false],
  ] as const)("applies the %s display policy", (alert_level, color, title, silent, mention) => {
    const event = normalizeInstagramEvent({ ...watchdogPayload, alert_level });
    if (!event || event.status !== "failed") throw new Error("expected failure event");
    expect(event.alertLevel).toBe(alert_level);

    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({
      color,
      title,
      description: watchdogPayload.error_message,
      author: { name: "야있날 @yaitnal" },
    });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "게시물 유형", value: "경기 프리뷰" }),
      ]),
    );
    expect(message.flags).toBe(silent ? MessageFlags.SuppressNotifications : undefined);
    expect(message.content).toBe(mention ? "<@owner>" : undefined);
    expect(message.allowedMentions).toEqual(mention ? { users: ["owner"] } : undefined);
  });

  it("leaves failures without alert_level as they were", () => {
    const event = normalizeInstagramEvent(watchdogPayload);
    if (!event || event.status !== "failed") throw new Error("expected failure event");
    expect(event.alertLevel).toBeUndefined();

    const message = buildInstagramMessage(event);
    expect(Object.keys(message)).toEqual(["embeds", "components"]);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ color: 0xed4245, title: "야있날 자동 게시 실패" });
  });

  it.each(["urgent", "DELAY", "constructor", "", 3, null, ["delay"]])(
    "treats unknown alert_level %j as absent",
    (alert_level) => {
      const event = normalizeInstagramEvent({ ...watchdogPayload, alert_level });
      if (!event || event.status !== "failed") throw new Error("expected failure event");
      expect(event.alertLevel).toBeUndefined();
      expect(JSON.stringify(buildInstagramMessage(event))).toBe(
        JSON.stringify(buildInstagramMessage(normalizeInstagramEvent(watchdogPayload)!)),
      );
    },
  );

  it("lets the owner retry or skip a job from the alert, and shows what the watchdog did with it", async () => {
    for (const mock of [mocks.alertsSend, mocks.fetchMessage]) mock.mockClear();
    const jobId = "jakkuyagu:flow-reel:game-9";
    const deliver = (extra: object) =>
      handleInstagramEvent(normalizeInstagramEvent({ ...watchdogPayload, source_key: jobId, ...extra })!);
    const rows = (components: Array<{ toJSON(): unknown }>) => components.map((row) => row.toJSON());
    const pending = () => pendingProblemRequests().filter((request) => request.job_id === jobId);
    const actionFields = (call: number) =>
      edit.mock.calls[call]![0].embeds[0].toJSON().fields.filter((field: { name: string }) => field.name === "운영자 조치");

    // 워치독이 허용한 조치만 버튼으로 붙는다. 모르는 조치는 버린다.
    expect(await deliver({ alert_level: "action", actions: ["retry", "skip", "rm -rf"] })).toBe(true);
    const sent = mocks.alertsSend.mock.calls[0]![0];
    const id = (await mocks.alertsSend.mock.results[0]!.value).id;
    expect(rows(sent.components)[1]).toMatchObject({
      components: [
        { custom_id: "igack" },
        { custom_id: "igop:retry", label: "다시 시도" },
        { custom_id: "igop:skip", label: "건너뛰기" },
      ],
    });

    // 다시 시도: 요청을 적어 두고 버튼 줄을 뗀다. 워치독이 가져갈 목록에 오른다.
    const update = vi.fn();
    await requestProblemAction({ message: { id, ...sent }, update } as never, "retry");
    expect(update.mock.calls[0]![0]).toMatchObject({ content: null, components: [sent.components[0]] });
    expect(update.mock.calls[0]![0].embeds[0].toJSON().fields.at(-1)).toMatchObject({
      name: "운영자 조치",
      value: expect.stringContaining("다시 시도 요청"),
    });
    expect(pending()).toMatchObject([{ job_id: jobId, action: "retry" }]);
    const { at } = pending()[0]!;

    // 중간 경과(started)는 칸만 바꾸고 요청을 남긴다. 다른 요청의 결과는 무시한다.
    const edit = vi.fn();
    mocks.fetchMessage.mockResolvedValue({ ...sent, embeds: update.mock.calls[0]![0].embeds, edit });
    await applyProblemResults([
      { job_id: jobId, at, state: "started", detail: "자동 복구를 다시 시작했습니다." },
      null,
      { job_id: jobId, at: at - 1, state: "done", detail: "지난 요청" },
    ]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(actionFields(0)).toEqual([{ name: "운영자 조치", value: "🔁 자동 복구를 다시 시작했습니다." }]);
    expect(edit.mock.calls[0]![0].components).toEqual([sent.components[0]]);
    expect(pending()).toHaveLength(1);

    // 거절: 요청을 끝내고 버튼을 되살린다.
    await applyProblemResults([{ job_id: jobId, at, state: "rejected", detail: "지금은 실행할 수 없습니다." }]);
    expect(actionFields(1)).toEqual([{ name: "운영자 조치", value: "⚠️ 지금은 실행할 수 없습니다." }]);
    expect(rows(edit.mock.calls[1]![0].components.slice(1))).toMatchObject([
      { components: [{ custom_id: "igack" }, { custom_id: "igop:retry" }, { custom_id: "igop:skip" }] },
    ]);
    expect(pending()).toEqual([]);

    // 건너뛰기: 워치독이 보낸 닫는 알림이 같은 메시지를 회색으로 닫고 요청도 사라진다.
    await requestProblemAction({ message: { id, ...sent }, update } as never, "skip");
    expect(pending()).toMatchObject([{ action: "skip" }]);
    expect(await deliver({ alert_level: "skipped", error_message: "운영자가 건너뜀" })).toBe(true);
    expect(edit.mock.calls[2]![0].embeds[0].toJSON()).toMatchObject({ color: 0x95a5a6, title: "야있날 게시 건너뜀" });
    expect(pending()).toEqual([]);
    expect(mocks.alertsSend).toHaveBeenCalledTimes(1);

    // 닫힌 알림의 버튼, 모르는 조치는 요청으로 받지 않는다.
    const reply = vi.fn();
    await requestProblemAction({ message: { id, ...sent }, reply } as never, "retry");
    expect(reply.mock.calls[0]![0].content).toContain("이미 닫혔거나");
    mocks.fetchMessage.mockReset();
  });
});
