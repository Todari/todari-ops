import { createHmac, timingSafeEqual } from "node:crypto";

// Sentry signs the raw body with HMAC SHA256 keyed on the integration's
// Client Secret. Header: `Sentry-Hook-Signature: <hex>`.
// Reference: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
export function verifySentry(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  return verifyHexHmac("sha256", rawBody, signatureHeader, secret);
}

// GitHub signs with HMAC SHA256. Header: `X-Hub-Signature-256: sha256=<hex>`.
export function verifyGithub(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  const hex = signatureHeader?.replace(/^sha256=/, "");
  return verifyHexHmac("sha256", rawBody, hex, secret);
}

// Vercel signs with HMAC SHA1. Header: `x-vercel-signature: <hex>`.
export function verifyVercel(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  return verifyHexHmac("sha1", rawBody, signatureHeader, secret);
}

function verifyHexHmac(
  algo: "sha1" | "sha256",
  rawBody: Buffer,
  signatureHex: string | undefined,
  secret: string,
): boolean {
  if (!signatureHex || !secret) return false;
  const expected = createHmac(algo, secret).update(rawBody).digest("hex");
  const got = signatureHex.trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
