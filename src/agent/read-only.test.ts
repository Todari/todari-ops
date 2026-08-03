import { describe, expect, it } from "vitest";
import { isSafeReadOnlyBash } from "./read-only.js";

describe("isSafeReadOnlyBash", () => {
  it.each([
    "git status --short --branch",
    "git log --oneline -10",
    "git diff -- README.md",
    "ls -la src",
    "head -n 20 README.md",
    "pwd",
  ])("allows a diagnostic read command: %s", (command) => {
    expect(isSafeReadOnlyBash(command)).toBe(true);
  });

  it.each([
    "git status && touch compromised",
    "ls; rm -rf data",
    "git log | sh",
    "cat README.md > copied.md",
    "head README.md\ntouch compromised",
    "cat $(pwd)/.env",
    "cat `pwd`/.env",
    "find src -delete",
    "git branch -D main",
    "git diff --output=changed.patch",
    "git grep --open-files-in-pager=sh pattern",
  ])("rejects a mutating or composed command: %s", (command) => {
    expect(isSafeReadOnlyBash(command)).toBe(false);
  });
});
