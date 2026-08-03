// Session store: in-memory Map with JSON write-through under WORK_DIR (docker
// volume) so thread sessions survive bot restarts. Claude-side conversation
// state lives in the SDK's ~/.claude dir — persisted via its own volume, see
// docker-compose.yml.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface Session {
  threadId: string;
  projectSlug: string;
  sessionId?: string;
  permissionMode: PermissionMode;
  createdAt: number;
}

const FILE = path.join(env.WORK_DIR, "sessions.json");

const sessions = new Map<string, Session>(loadFromDisk());

function loadFromDisk(): Array<[string, Session]> {
  try {
    if (!existsSync(FILE)) return [];
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Session[];
    if (!Array.isArray(raw)) return [];
    console.log(`[sessions] restored ${raw.length} sessions from disk`);
    return raw.filter((s) => s && s.threadId).map((s) => [s.threadId, s]);
  } catch (err) {
    console.warn("[sessions] failed to load sessions.json:", err);
    return [];
  }
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await writeFile(tmp, JSON.stringify([...sessions.values()], null, 2));
    await rename(tmp, FILE);
  } catch (err) {
    console.warn("[sessions] persist failed:", err);
  }
}

export async function createSession(args: {
  threadId: string;
  projectSlug: string;
  permissionMode: PermissionMode;
}): Promise<Session> {
  const session: Session = {
    threadId: args.threadId,
    projectSlug: args.projectSlug,
    permissionMode: args.permissionMode,
    createdAt: Date.now(),
  };
  sessions.set(args.threadId, session);
  await persist();
  return session;
}

export async function getSession(threadId: string): Promise<Session | null> {
  return sessions.get(threadId) ?? null;
}

export function listSessions(): Session[] {
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateSessionId(threadId: string, sessionId: string): Promise<void> {
  const s = sessions.get(threadId);
  if (s) {
    s.sessionId = sessionId;
    await persist();
  }
}

export async function updatePermissionMode(
  threadId: string,
  mode: PermissionMode,
): Promise<void> {
  const s = sessions.get(threadId);
  if (s) {
    s.permissionMode = mode;
    await persist();
  }
}

export async function endSession(threadId: string): Promise<void> {
  sessions.delete(threadId);
  await persist();
  // TODO: cleanup workspace dir at WORK_DIR/<threadId>
}
