import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInstagram } from "./verify.js";

describe("verifyInstagram", () => {
  it("accepts only the HMAC-SHA256 signature of the exact request body", () => {
    const body = Buffer.from('{"account":"jakkuyagu"}');
    const signature = createHmac("sha256", "shared-secret").update(body).digest("hex");

    expect(verifyInstagram(body, signature, "shared-secret")).toBe(true);
    expect(verifyInstagram(Buffer.from("{}"), signature, "shared-secret")).toBe(false);
    expect(verifyInstagram(body, "not-hex", "shared-secret")).toBe(false);
  });
});
