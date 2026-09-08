import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// Exercise the platform binary that ships with the pinned SDK without making
// an LLM request or passing credentials/project configuration to the process.
const require = createRequire(import.meta.url);
const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
const fromAgent = createRequire(entry);
const sdk = JSON.parse(readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"));
const libc = process.platform === "linux" && existsSync("/etc/alpine-release") ? "-musl" : "";
const platform = `${process.platform}-${process.arch}${libc}`;
const nativeRoot = path.dirname(fromAgent.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`));
const native = JSON.parse(readFileSync(path.join(nativeRoot, "package.json"), "utf8"));
assert.equal(native.version, sdk.version, "Native binary and SDK versions must match");
assert.equal(typeof sdk.claudeCodeVersion, "string", "SDK must declare its bundled CLI version");
const directory = mkdtempSync(path.join(tmpdir(), "todari-sdk-cli-"));
try {
  const executable = path.join(nativeRoot, process.platform === "win32" ? "claude.exe" : "claude");
  const version = execFileSync(executable, ["--version"], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    encoding: "utf8", timeout: 15_000, maxBuffer: 16_384,
  }).trim();
  assert.equal(version.split(/\s+/)[0], sdk.claudeCodeVersion, "Bundled CLI version mismatch");
  console.log(`SDK ${sdk.version} native smoke OK (${platform}): ${version}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
