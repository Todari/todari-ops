import { askText, extractJson } from "../llm.js";

const PROFILE =
  "학습자는 일본어 기초(N5 근처, 히라가나 읽음) 수준이고 목표는 회화(말하기)다. " +
  "설명은 한국어로, 예문에는 후리가나와 반말/존댓말 구분을 넣고 발음·억양 포인트를 짧게 덧붙여라.";

export interface DailyPhrase {
  front: string; reading: string; meaning: string;
  example: string; exampleKo: string; note: string; kind: "phrase" | "word";
}
export interface Correction {
  corrected: string; natural: string; explanation: string; mistakes: string[];
}

export function parseDaily(raw: string): DailyPhrase {
  const o = extractJson(raw);
  if (!o.front) throw new Error("daily: missing front");
  return {
    front: String(o.front), reading: String(o.reading ?? ""), meaning: String(o.meaning ?? ""),
    example: String(o.example ?? ""), exampleKo: String(o.exampleKo ?? ""),
    note: String(o.note ?? ""), kind: o.kind === "word" ? "word" : "phrase",
  };
}

export function parseCorrection(raw: string): Correction {
  const o = extractJson(raw);
  return {
    corrected: String(o.corrected ?? ""), natural: String(o.natural ?? ""),
    explanation: String(o.explanation ?? ""),
    mistakes: Array.isArray(o.mistakes) ? o.mistakes.map(String) : [],
  };
}

// LLM 단발 호출은 공유 격리 헬퍼 askText(../llm.ts)를 쓴다(tools:[]·settingSources:[]).

export async function generateDailyPhrase(recentFronts: string[]): Promise<DailyPhrase> {
  const avoid = recentFronts.length ? `\n최근에 낸 것과 겹치지 마라: ${recentFronts.join(", ")}` : "";
  const raw = await askText(
    `${PROFILE}\n오늘의 회화 표현 하나를 골라 JSON만 출력해라. ` +
    `키: front(일본어 표현), reading(가나 읽기), meaning(한국어 뜻), example(예문 일본어), ` +
    `exampleKo(예문 뜻), note(발음/억양/뉘앙스 한 줄), kind("phrase"|"word").${avoid}`);
  return parseDaily(raw);
}

export async function answerQuestion(q: string): Promise<string> {
  return askText(`${PROFILE}\n다음 질문에 회화 학습 관점에서 간결히 답해라(마크다운):\n${q}`);
}

export async function correctSentence(jp: string): Promise<Correction> {
  const raw = await askText(
    `${PROFILE}\n다음 일본어 문장을 자연스럽게 교정하고 JSON만 출력해라. ` +
    `키: corrected(교정문), natural(더 자연스러운 대안 또는 빈 문자열), ` +
    `explanation(왜 그런지 한국어), mistakes(고친 항목 문자열 배열).\n문장: ${jp}`);
  return parseCorrection(raw);
}
