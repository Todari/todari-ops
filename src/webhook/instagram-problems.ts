// 워치독 알림(문제)마다 Discord에 올린 메시지의 위치. 문제가 닫히면 새 메시지를 보내지 않고
// 이 메시지를 고쳐 "문제 하나에 메시지 하나"를 지킨다. 중단은 며칠씩 가고 봇은 배포마다
// 재시작하므로 /data 볼륨에 둔다.

import path from "node:path";
import { env } from "../env.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";

export interface ProblemMessage {
  channelId: string;
  messageId: string;
  at: number;
  /** 소유자가 "확인함"을 눌렀다. 닫힐 때까지 같은 문제를 다시 알리지 않는다. */
  acked?: boolean;
}

const FILE = path.resolve(env.WORK_DIR, "..", "instagram-problems.json");
// 닫히지 않고 남는 기록(지난 회차의 "확인 필요" 등)은 이 기간 뒤 버린다.
const KEEP_MS = 60 * 86_400_000;

let problems: Record<string, ProblemMessage> | null = null;
const load = () => (problems ??= readJsonObject<ProblemMessage>(FILE));

export function getProblemMessage(key: string): ProblemMessage | undefined {
  return load()[key];
}

export function findProblemKey(messageId: string): string | undefined {
  return Object.entries(load()).find(([, value]) => value.messageId === messageId)?.[0];
}

/** value가 null이면 기록을 지운다. */
export function setProblemMessage(key: string, value: ProblemMessage | null): void {
  const state = load();
  if (value) state[key] = value;
  else delete state[key];
  for (const [k, v] of Object.entries(state)) {
    if (Date.now() - v.at > KEEP_MS) delete state[k];
  }
  writeJsonObject(FILE, state);
}
