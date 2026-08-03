import { env } from "../env.js";

// Minimal GitHub REST helper shared by digest/weekly. Returns null on any
// failure — callers render partial data instead of failing the whole post.
const GITHUB_API = "https://api.github.com";

export async function ghJson<T>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "todari-ops/1.0",
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[github] ${res.status} for ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[github] fetch failed for ${path}:`, err);
    return null;
  }
}
