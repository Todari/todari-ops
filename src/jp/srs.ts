export type Grade = "again" | "hard" | "good";

export interface SrsState {
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
}

const MIN_EASE = 1.3;
const clampEase = (e: number) => Math.max(MIN_EASE, Number(e.toFixed(2)));

export function nextSchedule(s: SrsState, grade: Grade, now: Date) {
  let { intervalDays, ease, reps, lapses } = s;
  if (grade === "again") {
    intervalDays = 1;
    ease = clampEase(ease - 0.2);
    lapses += 1;
  } else if (grade === "hard") {
    intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    ease = clampEase(ease - 0.05);
  } else {
    intervalDays =
      intervalDays === 0 ? 1 : Math.max(1, Math.round(intervalDays * ease));
  }
  reps += 1;
  const dueAt = new Date(now.getTime() + intervalDays * 86_400_000);
  return { intervalDays, ease, reps, lapses, dueAt };
}
