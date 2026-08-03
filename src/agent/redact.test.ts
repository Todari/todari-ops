import { describe, expect, it } from "vitest";
import { redactSensitive } from "./redact.js";

describe("redactSensitive", () => {
  it("redacts sensitive object fields recursively", () => {
    expect(
      redactSensitive({
        command: "deploy",
        auth: { apiKey: "secret-value", password: "hunter2" },
      }),
    ).toEqual({
      command: "deploy",
      auth: { apiKey: "[REDACTED]", password: "[REDACTED]" },
    });
  });

  it("redacts credentials embedded in strings", () => {
    const redacted = redactSensitive(
      "curl -H 'Authorization: Bearer abc.def' " +
        "https://x-access-token:plain-token@github.com/example/repo.git?token=query-token",
    );

    expect(String(redacted)).not.toContain("abc.def");
    expect(String(redacted)).not.toContain("plain-token");
    expect(String(redacted)).not.toContain("query-token");
  });
});
