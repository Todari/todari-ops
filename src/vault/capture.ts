import { fetchInboxChannel } from "../discord/alerts.js";
import { captureException } from "../observability/sentry.js";
import {
  applyVaultCapture,
  noteNameForProject,
  type VaultCaptureKind,
  type VaultMutationResult,
} from "./mutations.js";
import { addCapturedVaultTask } from "./state.js";

export interface CaptureOutcome {
  mode: "written" | "queued" | "failed";
  result?: VaultMutationResult;
  error?: string;
}

export async function captureToVault(
  kind: VaultCaptureKind,
  projectSlug: string | undefined,
  text: string,
): Promise<CaptureOutcome> {
  try {
    const result = await applyVaultCapture(kind, projectSlug, text);
    if (kind === "task") {
      const slug = projectSlug || "todari-ops";
      await addCapturedVaultTask(noteNameForProject(slug), slug, text);
    }
    return { mode: "written", result };
  } catch (err) {
    captureException(err, { kind: "vault-capture-fallback", captureKind: kind, projectSlug });
    try {
      const channel = await fetchInboxChannel();
      if (!channel) {
        return { mode: "failed", error: errorMessage(err) };
      }
      await channel.send(
        `📥 [${kind}]${projectSlug ? ` (${projectSlug})` : ""} ${text}`.slice(0, 1900),
      );
      return { mode: "queued", error: errorMessage(err) };
    } catch (queueError) {
      captureException(queueError, {
        kind: "vault-capture-queue-failed",
        captureKind: kind,
        projectSlug,
      });
      return {
        mode: "failed",
        error: `${errorMessage(err)}; queue: ${errorMessage(queueError)}`,
      };
    }
  }
}

export function captureOutcomeText(
  outcome: CaptureOutcome,
  label: string,
  projectSlug?: string,
): string {
  const project = projectSlug ? ` (${projectSlug})` : "";
  if (outcome.mode === "written") {
    const detail = outcome.result?.summary || "볼트에 반영했습니다.";
    return `✅ ${label}을 바로 반영했어요${project} — ${detail}`;
  }
  if (outcome.mode === "queued") {
    return `📥 즉시 반영 중 충돌이 있어 ${label}을 안전 큐에 보관했어요${project}. Mac이 켜지면 자동 재처리합니다.`;
  }
  return `⚠️ ${label}을 저장하지 못했고 안전 큐도 사용할 수 없어요${project}. 운영 알림을 확인해 주세요.`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
