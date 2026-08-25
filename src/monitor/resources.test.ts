import { describe, it, expect } from "vitest";
import { parseMemInfo, memUsage, swapUsage } from "./resources.js";

const SAMPLE = `MemTotal:        3926016 kB
MemFree:          200000 kB
MemAvailable:     400000 kB
Buffers:           10000 kB
SwapTotal:       4194300 kB
SwapFree:        1048575 kB
`;

describe("parseMemInfo", () => {
  it("extracts the four fields in kB", () => {
    const m = parseMemInfo(SAMPLE);
    expect(m.memTotal).toBe(3926016);
    expect(m.memAvailable).toBe(400000);
    expect(m.swapTotal).toBe(4194300);
    expect(m.swapFree).toBe(1048575);
  });

  it("returns 0 for missing fields (e.g. no swap)", () => {
    const m = parseMemInfo("MemTotal: 100 kB\nMemAvailable: 50 kB\n");
    expect(m.swapTotal).toBe(0);
    expect(m.swapFree).toBe(0);
  });
});

describe("usage ratios", () => {
  it("memUsage = (total-available)/total", () => {
    const m = parseMemInfo(SAMPLE);
    expect(memUsage(m)).toBeCloseTo((3926016 - 400000) / 3926016); // ≈0.898
  });

  it("swapUsage = (total-free)/total", () => {
    const m = parseMemInfo(SAMPLE);
    expect(swapUsage(m)).toBeCloseTo((4194300 - 1048575) / 4194300); // ≈0.75
  });

  it("swapUsage is 0 when no swap (avoids divide-by-zero)", () => {
    expect(swapUsage({ memTotal: 100, memAvailable: 50, swapTotal: 0, swapFree: 0 })).toBe(0);
  });
});

describe("diskUsage", () => {
  it("computes df-style ratio excluding root-reserved blocks", async () => {
    const { diskUsage } = await import("./resources.js");
    // 100 blocks, 10 free(5 reserved), 5 avail → used 90 / (90+5) ≈ 0.947
    expect(diskUsage(100, 10, 5)).toBeCloseTo(90 / 95, 5);
    expect(diskUsage(0, 0, 0)).toBe(0);
  });
});
