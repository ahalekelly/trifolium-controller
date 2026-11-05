import { describe, expect, it } from "vitest";
import { LAYOUTS } from "../esc/layouts";
import { V4_DEFAULT } from "../esc/testdata";
import {
  BASELINE,
  baselineOf,
  candidatesFor,
  captureFile,
  DEFAULT_CONFIG,
  DEFAULT_GAINS,
  escOriginals,
  measure,
  nextSet,
  plannedEscWrites,
  scoreOf,
  startRun,
  type EscGrid,
  type Run,
  type Spinup,
} from "./run";

const GAINS = { control: "pid" as const, kp: 0.2, ki: 0.5 };
const BASE = { gains: GAINS, esc: null };

const spinup = (readyMs: number | null): Spinup => ({
  rpm: 30000,
  file: "a.csv",
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
    const both = { ...DEFAULT_GAINS, mode: "both" as const, kp: [0.1, 0.2, 0.1], ki: [0.5], tbh: [0.05] };
    expect(candidatesFor(both, BASE)).toEqual([
      { id: "PID kp 0.1 ki 0.5", gains: { control: "pid", kp: 0.1, ki: 0.5 }, esc: null },
      { id: "PID kp 0.2 ki 0.5", gains: { control: "pid", kp: 0.2, ki: 0.5 }, esc: null },
      { id: "TBH gain 0.05", gains: { control: "tbh", kp: 0.2, ki: 0.05 }, esc: null },
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
    const grid = { ...DEFAULT_GAINS, kp: [0.1, 0.2, 0.4], ki: [0.25, 0.5, 1] };
    const ids = order(startRun({ ...DEFAULT_CONFIG, grid, n: 3 }, BASE, null, 500));
    expect(ids[0]).toBe(BASELINE);
    expect(ids[ids.length - 1]).toBe(BASELINE);
    expect(ids[9]).toBe(BASELINE);
    // Every round ends on n = 3 sets here, so the first round spends them all.
    expect(ids.filter((id) => id !== BASELINE)).toHaveLength(27);
  });

  it("scores a set on its summed spin-ups, a timed-out one at the rampup timeout", () => {
    const set = { id: "x", at: 0, spinups: [spinup(150), { ...spinup(200), overshootPct: 4 }] };
    expect(scoreOf(set, 500)).toEqual({ timedOut: false, ms: 350, overshootPct: 4 });
    const timedOut = scoreOf({ ...set, spinups: [spinup(150), spinup(null)] }, 500);
    expect(timedOut).toMatchObject({ timedOut: true, ms: 650 });
  });
});

describe("captureFile", () => {
  it("names a capture by its run's start, set index, label and RPM", () => {
    const run = startRun(DEFAULT_CONFIG, BASE, null, 500);
    run.startedAt = new Date(2026, 10, 5, 14, 50, 37).getTime();
    expect(captureFile(run, BASELINE, 30000)).toBe(
      "tune-2026-11-05_14-50-37_set000_baseline-PID-kp-0.2-ki-0.5_30000rpm.csv",
    );
    run.sets.push({ id: BASELINE, at: 0, spinups: [] });
    expect(captureFile(run, "TBH gain 0.05", 25000)).toBe(
      "tune-2026-11-05_14-50-37_set001_TBH-gain-0.05_25000rpm.csv",
    );
  });
});

describe("an ESC run", () => {
  const field = (name: string) => LAYOUTS[4].fields.find((f) => f.name === name)!;
  const grid = (values: Record<string, number[]>): EscGrid => ({
    kind: "esc",
    fields: Object.entries(values).map(([name, raws]) => ({ field: field(name), values: raws })),
  });

  it("tries every combination, labelled as shown, on the blaster's own gains", () => {
    const esc = { pwm_frequency: 24, motor_kv: 0 };
    const candidates = candidatesFor(grid({ pwm_frequency: [16, 48], motor_kv: [0, 80] }), {
      gains: GAINS,
      esc,
    });
    expect(candidates.map((c) => c.id)).toEqual([
      "PWM frequency 16 kHz, Motor Kv Off (low-RPM power protection disabled)",
      "PWM frequency 16 kHz, Motor Kv 3220 Kv",
      "PWM frequency 48 kHz, Motor Kv Off (low-RPM power protection disabled)",
      "PWM frequency 48 kHz, Motor Kv 3220 Kv",
    ]);
    expect(candidates[1]).toMatchObject({ gains: GAINS, esc: { pwm_frequency: 16, motor_kv: 80 } });
  });

  it("puts back the value every ESC holds, and refuses ESCs that differ", () => {
    const other = V4_DEFAULT.slice();
    other[25] = 120; // startup_power
    const escs = [V4_DEFAULT, other].map((block, esc) => ({ esc, layout: LAYOUTS[4], block }));
    expect(escOriginals(escs, grid({ advance_level: [10] }))).toEqual({
      advance_level: V4_DEFAULT[23],
    });
    expect(() => escOriginals(escs, grid({ startup_power: [100] }))).toThrow(
      /The ESCs differ on Startup power \(100 %, 120 %\)/,
    );
  });

  it("names a capture file for the baseline's and the candidate's ESC settings", () => {
    const run = startRun(
      { ...DEFAULT_CONFIG, grid: grid({ startup_power: [80] }) },
      { gains: GAINS, esc: { startup_power: 100 } },
      null,
      500,
    );
    run.startedAt = new Date(2026, 10, 5, 14, 50, 37).getTime();
    expect(captureFile(run, BASELINE, 30000)).toBe(
      "tune-2026-11-05_14-50-37_set000_baseline-Startup-power-100_30000rpm.csv",
    );
    expect(captureFile(run, run.candidates[0].id, 30000)).toMatch(/_Startup-power-80_30000rpm\.csv$/);
  });

  it("runs each candidate's round as one block, and baselines in blocks of 3 between", () => {
    const config = { ...DEFAULT_CONFIG, grid: grid({ pwm_frequency: [16, 24, 32, 48] }), n: 20 };
    const ids = order(startRun(config, { gains: GAINS, esc: { pwm_frequency: 24 } }, null, 500));
    const blocks: [string, number][] = [];
    for (const id of ids) {
      const last = blocks[blocks.length - 1];
      if (last?.[0] === id) last[1]++;
      else blocks.push([id, 1]);
    }
    const [c16, c24, c32, c48] = startRun(config, BASE, null, 500).candidates.map((c) => c.id);
    // Rounds end on 10 and 20 sets. A baseline block comes at the first block's end after 24
    // candidate sets, and the last one leaves the ESCs on the settings the run started with.
    expect(blocks).toEqual([
      [BASELINE, 3],
      [c16, 10],
      [c24, 10],
      [c32, 10],
      [BASELINE, 3],
      [c48, 10],
      [c16, 10],
      [c24, 10],
      [BASELINE, 3],
    ]);
    // Every block but the first is a write.
    expect(blocks.length - 1).toBeLessThanOrEqual(plannedEscWrites(4, 20));
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
      "a.csv",
      3,
    );
    expect(s).toEqual({ rpm: 30000, file: "a.csv", readyMs: 3, overshootPct: 2, packMv: 16400 });
    expect(trace).toEqual([0, 28000, 29900]);
  });

  it("refuses a capture that did not start from rest at the RPM asked for", () => {
    const report = { readyMs: 3, slowestMotor: 3, timedOut: false };
    const spinning = csv.replace("16400,0,30000", "16400,12000,30000");
    expect(() => measure({ csv: spinning, report }, 30000, "a.csv", 3)).toThrow(/motor 1 at 12000 RPM/);
    expect(() => measure({ csv, report }, 25000, "a.csv", 3)).toThrow(/aiming for 30000/);
  });
});
