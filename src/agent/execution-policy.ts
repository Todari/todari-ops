export type Effort = "low" | "medium" | "high" | "xhigh";
export interface ExecutionProfile {
  level: number;
  model: string;
  effort: Effort;
  modelPinned?: boolean;
  effortPinned?: boolean;
  reason: string;
}
const efforts: Effort[] = ["low", "medium", "high", "xhigh"];
const risk = /인증|로그인|권한|결제|마이그레이션|데이터\s*(삭제|손실)|장애|보안|authentication|authorization|login|payment|migration|outage|security/i;
const complex = /원인\s*(불명|모르)|아키텍처|여러\s*(모듈|서비스)|교착|race condition|architecture|deadlock/i;
const simple = /^(요약|오타|문구|주석|파일\s*(찾|목록)|summarize|typo|list files)/i;
const repeated = /(같은|동일|다시|반복).{0,30}(테스트|검증|가설).{0,20}(실패|틀)|(?:same|repeated).{0,30}(?:test|hypothesis).{0,20}(?:fail|wrong)/i;
const infrastructure = /네트워크.{0,10}(오류|실패)|권한.{0,10}(없|부족|거부)|인증키.{0,10}(없|누락)|rate.?limit|timeout|timed out|network.{0,10}(error|fail)|permission denied|429|ECONN/i;

export function selectExecutionProfile(args: {
  prompt: string;
  previous?: ExecutionProfile;
  model?: string;
  defaultModel?: string;
  effort?: Effort;
  purpose?: "summary" | "diagnosis";
}): ExecutionProfile {
  const prior = args.previous;
  // 사용자 요청의 첫 줄에 명시한 선택만 해석한다. 로그나 코드 블록 속 값은 무시한다.
  const header = /^(?:model=[\w.:-]+|effort=(?:low|medium|high|xhigh))(?:\s+(?:model=[\w.:-]+|effort=(?:low|medium|high|xhigh)))*$/.test(args.prompt.split("\n")[0] ?? "")
    ? args.prompt.split("\n")[0]! : "";
  const explicitModel = /(?:^|\s)model=([\w.:-]+)/.exec(header)?.[1] || args.model;
  const explicitEffort = /(?:^|\s)effort=(low|medium|high|xhigh)/.exec(header)?.[1] as Effort | undefined;
  const taskText = header ? args.prompt.slice(header.length).trim() : args.prompt;
  const level = args.purpose === "summary" ? 0
    : args.purpose === "diagnosis" || risk.test(taskText) || complex.test(taskText) ? 2
    : simple.test(taskText.trim()) ? 0 : 1;
  const escalation = Boolean(prior && repeated.test(args.prompt) && !infrastructure.test(args.prompt));
  const selected = prior && infrastructure.test(args.prompt) ? prior.level
    : Math.max(level, prior ? Math.min(3, prior.level + Number(escalation)) : 0);
  const modelPinned = Boolean(explicitModel || prior?.modelPinned || args.defaultModel);
  const effortPinned = Boolean(explicitEffort || args.effort || prior?.effortPinned);
  return {
    level: selected,
    // 제공자별 fable 별칭 차이를 피하고 검증한 Fable 5.1을 선택한다.
    model: explicitModel || (prior?.modelPinned ? prior.model : args.defaultModel || (selected < 2 ? "sonnet" : "claude-fable-5-1")),
    effort: explicitEffort || args.effort || (prior?.effortPinned ? prior.effort : efforts[selected]!),
    modelPinned, effortPinned,
    reason: explicitModel || explicitEffort || args.effort ? "explicit-selection"
      : escalation ? "repeated-reasoning-failure" : prior ? "continued-task" : "task-complexity",
  };
}

export function sdkProfileOptions({ model, effort }: ExecutionProfile): { model: string; effort?: Effort } {
  return /haiku/i.test(model) ? { model } : { model, effort };
}

export function selectSdkProfile(args: Parameters<typeof selectExecutionProfile>[0]): { model: string; effort?: Effort } {
  return sdkProfileOptions(selectExecutionProfile(args));
}
