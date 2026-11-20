import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(), update: vi.fn(), channel: vi.fn(), capture: vi.fn(), send: vi.fn(),
}));
vi.mock("./mutations.js", () => ({
  applyVaultCapture: mocks.apply,
  noteNameForProject: (slug: string) => slug,
}));
vi.mock("./state.js", () => ({ addCapturedVaultTask: mocks.update }));
vi.mock("../discord/alerts.js", () => ({ fetchInboxChannel: mocks.channel }));
vi.mock("../observability/sentry.js", () => ({ captureException: mocks.capture }));

import { captureToVault } from "./capture.js";

describe("captureToVault durability boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.channel.mockResolvedValue({ send: mocks.send });
  });

  it("keeps a successful vault write when the derived snapshot fails", async () => {
    const result = { changed: true, summary: "saved", commit: "abc" };
    mocks.apply.mockResolvedValue(result);
    mocks.update.mockRejectedValue(new Error("disk unavailable"));
    expect(await captureToVault("task", "todari", "task")).toEqual({ mode: "written", result });
    expect(mocks.channel).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: "vault-capture-state-failed" }));
  });

  it("queues only when the source vault mutation fails", async () => {
    mocks.apply.mockRejectedValue(new Error("push conflict"));
    expect((await captureToVault("task", "todari", "task")).mode).toBe("queued");
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
