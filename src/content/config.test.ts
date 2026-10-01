import { afterEach, expect, it, vi } from "vitest";
import { publishReady } from "./index.js";
afterEach(() => vi.unstubAllEnvs());
it("keeps review drafts unpublishable until an account and publishing credentials are connected", () => {
  vi.stubEnv("CONTENT_PUBLISH_ENABLED", "false");
  expect(publishReady("instatoon", null)).toBe(false);
  vi.stubEnv("CONTENT_PUBLISH_ENABLED", "true");
  vi.stubEnv("INSTATOON_IG_USER_ID", "123");
  vi.stubEnv("INSTATOON_IG_ACCESS_TOKEN", "test");
  vi.stubEnv("CONTENT_GRAPH_VERSION", "v25.0");
  vi.stubEnv("CONTENT_S3_BUCKET", "bucket");
  expect(publishReady("instatoon", null)).toBe(false);
  expect(publishReady("instatoon", "other-account")).toBe(false);
  expect(publishReady("instatoon", "123")).toBe(true);
  vi.stubEnv("INSTATOON_IG_API", "instagram");
  expect(publishReady("instatoon", "123")).toBe(true);
  vi.stubEnv("INSTATOON_IG_API", "invalid");
  expect(publishReady("instatoon", "123")).toBe(false);
});
