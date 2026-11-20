import { expect, it } from "vitest";
import { inboxCapturePayload } from "./inbox-capture.js";

it("retains the entire UTF-8 capture including the final character", () => {
  const original = "📥 [note] " + "긴 문장🙂".repeat(700) + "끝";
  const payload = inboxCapturePayload(original);
  expect(payload.content).toBe("📥 [file] inbox-capture.txt");
  expect(payload.files).toEqual([{ name: "inbox-capture.txt", attachment: Buffer.from(original) }]);
  expect(inboxCapturePayload("x".repeat(2000)).content).toHaveLength(2000);
});
