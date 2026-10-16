import { describe, expect, it } from "vitest";
import {
  BASELINE,
  baselineOf,
  candidatesFor,
  DEFAULT_CONFIG,
  measure,
  nextSet,
  scoreOf,
  startRun,
  type Run,
  type Spinup,
} from "./run";

const BASE = { control: "pid" as const, kp: 0.2, ki: 0.5 };

const spinup = (readyMs: number | null): Spinup => ({
  rpm: 30000,
  readyMs,
  overshootPct: 1,
  packMv: 16000,
});

/** Runs every set nextSet() asks for, returning the ids in order. */
function order(run: Run): string[] {
  let current = run;
  const ids: string[] = [];
  for (;;) {
    const { search, next } = nextSet(current);
    if (next === null) return ids;
    ids.push(next);
    current = {
      ...current,
      search,
      sets: [...current.sets, { id: next, at: 0, spinups: [spinup(100)] }],
    };
  }
}

describe("a gains run", () => {
  it("grids PID's kp with ki, and gives TBH its gains on ki, each value once", () => {
    const both = {
      ...DEFAULT_CONFIG,
      mode: "both" as const,
      kp: [0.1, 0.2, 0.1],
      ki: [0.5],
      tbh: [0.05],
    };
    expect(candidatesFor(both, BASE)).toEqual([
      { id: "PID kp 0.1 ki 0.5", gains: { control: "pid", kp: 0.1, ki: 0.5 } },
      { id: "PID kp 0.2 ki 0.5", gains: { control: "pid", kp: 0.2, ki: 0.5 } },
      { id: "TBH gain 0.05", gains: { control: "tbh", kp: 0.2, ki: 0.05 } },
    ]);
  });

  it("starts from the blaster's control mode and its first enabled motor's gains", () => {
    const device = {
      flywheelControl: "tbh",
      motorConfig: [
        { enabled: false, kp: 1, ki: 1 },
        { enabled: true, kp: 0.3, ki: 0.07 },
      ],
    };
    expect(baselineOf(device)).toEqual({ control: "tbh", kp: 0.3, ki: 0.07 });
  });

  it("opens and closes on the baseline, with one every eight candidate sets between", () => {
    const config = { ...DEFAULT_CONFIG, kp: [0.1, 0.2, 0.4], ki: [0.25, 0.5, 1], n: 3 };
    const ids = order(startRun(config, BASE));
    expect(ids[0]).toBe(BASELINE);
    expect(ids[ids.length - 1]).toBe(BASELINE);
    expect(ids[9]).toBe(BASELINE);
    // Every round ends on n = 3 sets here, so the first round spends them all.
    expect(ids.filter((id) => id !== BASELINE)).toHaveLength(27);
  });

  it("scores a set on its summed spin-ups, timed out if any was", () => {
    const set = { id: "x", at: 0, spinups: [spinup(150), { ...spinup(200), overshootPct: 4 }] };
    expect(scoreOf(set)).toEqual({ timedOut: false, ms: 350, overshootPct: 4 });
    expect(scoreOf({ ...set, spinups: [spinup(150), spinup(null)] }).timedOut).toBe(true);
  });
});

describe("measure", () => {
  const csv = [
    "Voltage_mv,Motor 1,TargetRPM 1,Throttle 1,value 1,Motor 3,TargetRPM 3,Throttle 3,value 3,",
    "16400,0,30000,1999,0.00,0,30000,1999,0.00,",
    "16100,29000,30000,1999,0.00,28000,30000,1999,0.00,",
    "16000,30600,30000,1200,0.00,29900,30000,1999,0.00,",
    "16050,30100,30000,1100,0.00,30300,30000,1200,0.00,",
    "16050,30000,0,0,0.00,30000,0,0,0.00,",
  ].join("\n");

  it("takes the worst motor's overshoot past target once there, and the pack at the start", () => {
    const { spinup: s, trace } = measure(
      { csv, report: { readyMs: 3, slowestMotor: 3, timedOut: false } },
      30000,
      3,
    );
    expect(s).toEqual({ rpm: 30000, readyMs: 3, overshootPct: 2, packMv: 16400 });
    expect(trace).toEqual([0, 28000, 29900]);
  });
});
