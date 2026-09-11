import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  query,
  type CanUseTool,
  type SDKControlInitializeResponse,
  type SDKControlRequest,
  type SDKControlResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the installed SDK itself. Only its public subprocess transport is
// replaced: no CLI, credentials, user settings, network, or model is involved.
type InputFrame = SDKControlRequest | SDKControlResponse | SDKUserMessage;
const TOOL_INPUT = { command: "git status --short" };
const INIT_RESPONSE: SDKControlInitializeResponse = {
  commands: [], agents: [], models: [], account: {},
  output_style: "default", available_output_styles: ["default"],
};

class MemoryCli extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  readonly frames: InputFrame[] = [];
  readonly toolUseId = "offline-tool-use";
  readonly requestId = "offline-permission";
  killed = false;
  exitCode: number | null = null;
  private buffered = "";

  constructor(readonly sessionId: string) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.buffered += chunk.toString();
          let newline: number;
          while ((newline = this.buffered.indexOf("\n")) !== -1) {
            const line = this.buffered.slice(0, newline);
            this.buffered = this.buffered.slice(newline + 1);
            if (line.trim()) this.receive(JSON.parse(line) as InputFrame);
          }
          callback();
        } catch (error) {
          this.emit("error", error);
          callback();
        }
      },
      final: (callback) => {
        this.finish();
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.finish(signal);
    return true;
  }

  private finish(signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.emit("exit", 0, signal);
  }

  private send(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private receive(frame: InputFrame): void {
    this.frames.push(frame);
    if (frame.type === "control_request" && frame.request.subtype === "initialize") {
      this.send({
        type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: INIT_RESPONSE },
      });
      return;
    }
    if (frame.type === "user") {
      this.send({
        type: "control_request", request_id: this.requestId,
        request: {
          subtype: "can_use_tool", tool_name: "Bash", input: TOOL_INPUT,
          tool_use_id: this.toolUseId, decision_reason: "offline fixture approval",
        },
      } satisfies SDKControlRequest);
      return;
    }
    if (frame.type === "control_response" && frame.response.request_id === this.requestId) {
      if (frame.response.subtype !== "success") throw new Error("SDK rejected the permission callback");
      const denied = frame.response.response?.behavior === "deny";
      // Deliberately split an NDJSON frame across stream writes, then batch its
      // remainder with the result to cover framing as well as message dispatch.
      const partial = JSON.stringify({
        type: "stream_event", uuid: randomUUID(), session_id: this.sessionId,
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "offline result" } },
      });
      const result = JSON.stringify({
        type: "result", subtype: "success", uuid: randomUUID(), session_id: this.sessionId,
        is_error: false, result: "offline result", duration_ms: 1, duration_api_ms: 0,
        num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: denied ? [{ tool_name: "Bash", tool_use_id: this.toolUseId, tool_input: TOOL_INPUT }] : [],
      });
      const middle = Math.floor(partial.length / 2);
      this.stdout.write(partial.slice(0, middle));
      this.stdout.write(`${partial.slice(middle)}\n${result}\n`);
      return;
    }
    throw new Error(`Unexpected SDK input frame: ${frame.type}`);
  }
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "todari-ops-sdk-protocol-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("installed Agent SDK offline protocol", () => {
  it.each(["allow", "deny"] as const)("initializes, requests %s permission, and streams a resumed turn", async (behavior) => {
    const resume = randomUUID();
    const cli = new MemoryCli(resume);
    const spawn = vi.fn((_options: SpawnOptions): SpawnedProcess => cli);
    const updatedInput = { command: "git status --porcelain" };
    const canUseTool = vi.fn<CanUseTool>(async () => behavior === "allow"
      ? { behavior: "allow", updatedInput }
      : { behavior: "deny", message: "Denied by offline fixture" });
    const stream = query({
      prompt: "Check the repository without changing files.",
      options: {
        cwd, env: {}, settingSources: [], persistSession: false,
        // If the transport hook regresses, Node rejects CLI flags rather than
        // starting a real Claude CLI that could read credentials or make calls.
        pathToClaudeCodeExecutable: process.execPath,
        spawnClaudeCodeProcess: spawn,
        canUseTool, resume, includePartialMessages: true,
      },
    });
    try {
      expect(await stream.initializationResult()).toEqual(INIT_RESPONSE);
      const messages: SDKMessage[] = [];
      for await (const message of stream) messages.push(message);

      expect(spawn).toHaveBeenCalledTimes(1);
      const options = spawn.mock.calls[0][0];
      expect(options.cwd).toBe(cwd);
      expect(options.args).toContain("--setting-sources=");
      expect(options.args).toContain("--no-session-persistence");
      expect(options.args).toContain("--include-partial-messages");
      expect(options.args).toContain(`--resume=${resume}`);
      expect(options.args[options.args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
      // Compare names only so a failed isolation assertion cannot print secrets.
      expect(Object.keys(options.env).filter((name) => /TOKEN|API_KEY|HOME|CLAUDE_CONFIG_DIR/.test(name))).toEqual([]);

      expect(cli.frames[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
      expect(cli.frames.find((frame) => frame.type === "user")).toMatchObject({
        message: { role: "user", content: [{ type: "text", text: "Check the repository without changing files." }] },
      });
      expect(canUseTool).toHaveBeenCalledOnce();
      expect(canUseTool).toHaveBeenCalledWith("Bash", TOOL_INPUT, expect.objectContaining({
        toolUseID: cli.toolUseId, decisionReason: "offline fixture approval", signal: expect.any(AbortSignal),
      }));
      expect(cli.frames.find((frame) => frame.type === "control_response")).toMatchObject({
        type: "control_response",
        response: {
          subtype: "success", request_id: cli.requestId,
          response: {
            behavior, toolUseID: cli.toolUseId,
            ...(behavior === "allow" ? { updatedInput } : { message: "Denied by offline fixture" }),
          },
        },
      });
      expect(messages.map((message) => message.type)).toEqual(["stream_event", "result"]);
      expect(messages[0]).toMatchObject({ event: { delta: { text: "offline result" } }, session_id: resume });
      expect(messages[1]).toMatchObject({
        type: "result", subtype: "success", result: "offline result", session_id: resume,
        permission_denials: behavior === "deny" ? [expect.objectContaining({ tool_name: "Bash" })] : [],
      });
      expect(cli.stdin.writableEnded).toBe(true);
      expect(cli.exitCode).toBe(0);
    } finally {
      stream.close();
      cli.stdin.end();
    }
  }, 5000);
});
