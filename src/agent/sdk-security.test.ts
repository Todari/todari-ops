import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Resolve the actual transitive dependency selected for Agent SDK, not a
// separately installed test copy. No API key, network, or Claude session needed.
const require = createRequire(import.meta.url);
const requireFromAgent = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
interface MemoryTool {
  create(command: { command: "create"; path: string; file_text: string }): Promise<string>;
  str_replace(command: {
    command: "str_replace"; path: string; old_str: string; new_str: string;
  }): Promise<string>;
  view(command: { command: "view"; path: string }): Promise<string>;
}
const { BetaLocalFilesystemMemoryTool } = requireFromAgent("@anthropic-ai/sdk/tools/memory/node") as {
  BetaLocalFilesystemMemoryTool: { init(basePath: string): Promise<MemoryTool> };
};

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "todari-sdk-security-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("SDK memory permissions (GHSA-p7fg-763f-g4gf)", () => {
  it("creates the memory root with owner-only permissions", async () => {
    await BetaLocalFilesystemMemoryTool.init(directory);
    expect((await stat(path.join(directory, "memories"))).mode & 0o777).toBe(0o700);
  });

  it("keeps new nested directories and files private", async () => {
    const memory = await BetaLocalFilesystemMemoryTool.init(directory);
    await memory.create({ command: "create", path: "/memories/nested/note.md", file_text: "test state" });
    expect((await stat(path.join(directory, "memories", "nested"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, "memories", "nested", "note.md"))).mode & 0o777).toBe(0o600);
  });

  it("retains private permissions through atomic replacement and preserves content", async () => {
    const memory = await BetaLocalFilesystemMemoryTool.init(directory);
    const file = path.join(directory, "memories", "note.md");
    await memory.create({ command: "create", path: "/memories/note.md", file_text: "before" });
    await memory.str_replace({ command: "str_replace", path: "/memories/note.md", old_str: "before", new_str: "after" });
    expect(await readFile(file, "utf8")).toBe("after");
    expect(await memory.view({ command: "view", path: "/memories/note.md" })).toContain("after");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
