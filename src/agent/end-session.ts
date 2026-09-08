import type { ThreadChannel } from "discord.js";
import { getSession, endSession } from "../storage/sessions.js";
import { completeVaultTask } from "../vault/mutations.js";
import { completeCapturedVaultTask } from "../vault/state.js";
import { captureException } from "../observability/sentry.js";
import { beginSessionEnd, releaseSessionEnd } from "./run.js";
import { postSessionSummary } from "./summary.js";

const OUTCOMES = { completed: "완료", paused: "보류", abandoned: "중단" } as const;

export async function closeCodeSession(
  thread: ThreadChannel,
  requestedOutcome: string | null,
): Promise<{ closed: boolean; message: string }> {
  const outcome = requestedOutcome ?? "paused";
  if (!Object.hasOwn(OUTCOMES, outcome)) {
    return { closed: false, message: "종료 결과는 completed·paused·abandoned 중에서 선택해 주세요." };
  }
  const lock = beginSessionEnd(thread.id);
  if (lock !== "locked") {
    return { closed: false, message: lock === "active"
      ? "아직 작업 중입니다. 작업이 끝난 뒤 종료하거나 `/cancel`로 중지한 뒤 다시 종료해 주세요."
      : "세션 종료를 이미 처리하고 있습니다." };
  }
  try {
    const session = await getSession(thread.id);
    if (!session) return { closed: false, message: "이 스레드에는 활성 세션이 없습니다." };
    let taskDetail = session.sourceTask ? "원본 할 일은 열린 상태로 유지합니다." : "";
    if (outcome === "completed" && session.sourceTask) {
      const task = session.sourceTask;
      try {
        const result = await completeVaultTask(task);
        if (!result.changed) {
          return { closed: false, message: "원본 할 일의 미완료 체크박스를 찾지 못해 완료 여부를 확인할 수 없습니다. 세션을 유지합니다. 원본을 확인하거나 `/end result:paused`로 세션만 종료해 주세요." };
        }
      } catch (error) {
        captureException(error, { kind: "vault-task-finish", projectSlug: session.projectSlug });
        return { closed: false, message: "원본 할 일을 완료 처리하지 못했습니다. 세션을 유지했으니 잠시 후 `/end result:completed`로 다시 시도해 주세요." };
      }
      taskDetail = "원본 볼트 할 일도 완료 처리했습니다.";
      // The source commit already succeeded; a derived snapshot failure must
      // not turn it into an apparent source failure or prompt another write.
      try {
        await completeCapturedVaultTask(task.note, task.projectSlug, task.text);
      } catch (error) {
        captureException(error, { kind: "vault-task-finish-snapshot", projectSlug: session.projectSlug });
        taskDetail += " 브리핑 반영은 다음 볼트 동기화 후 확인해 주세요.";
      }
    }
    await endSession(thread.id);
    const label = OUTCOMES[outcome as keyof typeof OUTCOMES];
    if (session.sessionId) void postSessionSummary(thread, session, label);
    return { closed: true, message: `🏁 ${label}로 세션을 종료했습니다.${taskDetail ? `\n${taskDetail}` : ""}` };
  } finally {
    releaseSessionEnd(thread.id);
  }
}
