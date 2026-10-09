import type { ThreadChannel } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { OWNER_DISCORD_ID: "owner", ACTION_ALLOWLIST: ["Bash"], PERMISSION_TIMEOUT_MS: 600_000 },
  audit: vi.fn(), send: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../storage/audit.js", () => ({ logAudit: mocks.audit }));
import { askPermission, resolvePending } from "./permissions.js";

const thread = { send: mocks.send } as unknown as ThreadChannel;
const ask = () => askPermission({ threadId: "t1", thread, toolName: "Bash", toolInput: { command: "ls" }, mode: "default" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.env.PERMISSION_TIMEOUT_MS = 600_000;
});
afterEach(() => vi.useRealTimers());

it("mentions the owner on the permission prompt and keeps the button contract", async () => {
  const decision = ask();
  const message = mocks.send.mock.calls[0]![0];
  expect(message.content).toBe("<@owner>");
  expect(message.allowedMentions).toEqual({ users: ["owner"] });
  const ids: string[] = message.components[0].toJSON().components.map((c: { custom_id: string }) => c.custom_id);
  const id = ids[0]!.split(":")[2]!;
  expect(ids).toEqual([`perm:approve:${id}`, `perm:approve-once:${id}`, `perm:deny:${id}`]);
  expect(await resolvePending(id, "approve-once")).toBe(true);
  await expect(decision).resolves.toBe("approve-once");
});

it.each([[600_000, "10분"], [90_000, "90초"]])("waits PERMISSION_TIMEOUT_MS=%i before auto-deny", async (timeout, label) => {
  mocks.env.PERMISSION_TIMEOUT_MS = timeout;
  const settled = vi.fn();
  const decision = ask().then((d) => { settled(d); return d; });
  expect(mocks.send.mock.calls[0]![0].embeds[0].toJSON().footer.text).toBe(`${label} 안에 응답 없으면 자동 거부`);
  await vi.advanceTimersByTimeAsync(timeout - 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(decision).resolves.toBe("deny");
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: "timeout-deny" }));
});
