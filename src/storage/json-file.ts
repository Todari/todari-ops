// /data 볼륨에 두는 작은 JSON 상태 파일의 읽기·쓰기.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 파일이 없거나 깨졌으면 빈 객체. */
export function readJsonObject<T>(file: string): Record<string, T> {
  try {
    const raw: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, T>) : {};
  } catch {
    return {};
  }
}

/** 동기 쓰기라 같은 틱의 여러 기록이 tmp 파일을 두고 겹치지 않는다. 실패는 경고만 남긴다. */
export function writeJsonObject(file: string, value: object): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`[storage] ${path.basename(file)} persist failed:`, err);
  }
}
