import { describe, it, expect } from "vitest";
import { nextSchedule, type SrsState } from "./srs.js";

const base: SrsState = { intervalDays: 4, ease: 2.3, reps: 2, lapses: 0 };
const now = new Date("2026-07-24T00:00:00Z");

describe("nextSchedule", () => {
  it("good multiplies interval by ease and keeps ease", () => {
    const r = nextSchedule(base, "good", now);
    expect(r.intervalDays).toBe(9); // round(4 * 2.3)
    expect(r.ease).toBeCloseTo(2.3);
    expect(r.reps).toBe(3);
    expect(r.dueAt).toEqual(new Date("2026-08-02T00:00:00Z")); // +9d
  });
  it("hard grows slowly and lowers ease a little", () => {
    const r = nextSchedule(base, "hard", now);
    expect(r.intervalDays).toBe(5); // max(1, round(4*1.2))
    expect(r.ease).toBeCloseTo(2.25);
  });
  it("again resets interval to 1, drops ease, counts a lapse", () => {
    const r = nextSchedule(base, "again", now);
    expect(r.intervalDays).toBe(1);
    expect(r.ease).toBeCloseTo(2.1);
    expect(r.lapses).toBe(1);
  });
  it("ease never drops below 1.3", () => {
    const low: SrsState = { ...base, ease: 1.35 };
    expect(nextSchedule(low, "again", now).ease).toBe(1.3);
  });
  it("new card (interval 0) good → interval 1", () => {
    const fresh: SrsState = { intervalDays: 0, ease: 2.3, reps: 0, lapses: 0 };
    expect(nextSchedule(fresh, "good", now).intervalDays).toBe(1);
  });
});
