import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { githubAuthEnv } from "./checkout.js";

describe("githubAuthEnv", () => {
  it("passes GitHub credentials through a scoped header", () => {
    const gitEnv = githubAuthEnv("example-token");

    expect(gitEnv.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/.extraheader",
    );
    expect(gitEnv.GIT_CONFIG_VALUE_0).not.toContain("example-token");
    expect(gitEnv.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:example-token").toString("base64")}`,
    );
    expect(gitEnv.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not configure an authorization header without a token", () => {
    const gitEnv = githubAuthEnv("");

    expect(gitEnv.GIT_CONFIG_COUNT).toBeUndefined();
    expect(gitEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});
