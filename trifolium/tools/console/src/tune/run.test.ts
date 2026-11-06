import { describe, expect, it } from "vitest";
import { LAYOUTS } from "../esc/layouts";
import { V4_DEFAULT } from "../esc/testdata";
import { ranking } from "./search";
import {
  BASELINE,
  baselineOf,
  candidatesFor,
  captureFile,
  DEFAULT_CONFIG,
  DEFAULT_GAINS,
  escOriginals,
  escNames,
  escRecords,
  measure,
  nextSet,
  overshootLimit,
  plannedRun,
  scoreOf,
  scoresOf,
  startingId,
  startRun,
  type EscGrid,
  type Run,
  TRACE_STEP,
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
  trace: [],
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
    const ids = order(startRun({ ...DEFAULT_CONFIG, grid, n: 3 }, BASE, null, null, 500));
    expect(ids[0]).toBe(BASELINE);
    expect(ids[ids.length - 1]).toBe(BASELINE);
    expect(ids[9]).toBe(BASELINE);
    // Every round ends on n = 3 sets here, so the first round spends them all - but kp 0.2 ki 0.5,
    // the blaster's own, has its 3 from the baseline.
    expect(ids.filter((id) => id !== BASELINE)).toHaveLength(24);
    expect(ids).not.toContain("PID kp 0.2 ki 0.5");
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
    const run = startRun(DEFAULT_CONFIG, BASE, null, null, 500);
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
    fields: Object.entries(values).map(([name, raws]) => ({
      field: field(name),
      values: raws.map((raw) => ({ [name]: raw })),
    })),
  });

  it("tries By RPM in PWM frequency's place, writing both fields every time", () => {
    const pwm = field("pwm_frequency");
    const byRpm = pwm.instead!.writes;
    const esc = { pwm_frequency: 24, variable_pwm: 0 };
    const frequencies: EscGrid = {
      kind: "esc",
      fields: [{ field: pwm, values: [{ pwm_frequency: 32 }, byRpm] }],
    };
    expect(escNames(frequencies)).toEqual(["pwm_frequency", "variable_pwm"]);
    expect(candidatesFor(frequencies, { gains: GAINS, esc })).toEqual([
      { id: "PWM frequency 32 kHz", gains: GAINS, esc: { pwm_frequency: 32, variable_pwm: 0 } },
      { id: "PWM frequency By RPM", gains: GAINS, esc: { pwm_frequency: 24, variable_pwm: 2 } },
    ]);
    // By RPM ignores the PWM type, so crossing the two leaves one By RPM candidate.
    const crossed: EscGrid = {
      kind: "esc",
      fields: [
        { field: field("variable_pwm"), values: [{ variable_pwm: 0 }, { variable_pwm: 1 }] },
        ...frequencies.fields,
      ],
    };
    expect(candidatesFor(crossed, { gains: GAINS, esc }).map((c) => c.id)).toEqual([
      "PWM type Fixed, PWM frequency 32 kHz",
      "PWM type By RPM, PWM frequency By RPM",
      "PWM type Variable, PWM frequency 32 kHz",
    ]);
    // The run puts back the PWM type too.
    const [record] = escRecords([{ esc: 0, layout: LAYOUTS[4], block: V4_DEFAULT }], [1]);
    expect(escOriginals([record], frequencies)).toEqual({
      pwm_frequency: V4_DEFAULT[24],
      variable_pwm: V4_DEFAULT[21],
    });
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

  it("records every field each ESC holds, raw and as shown, by the motor it drives", () => {
    const [record] = escRecords([{ esc: 0, layout: LAYOUTS[4], block: V4_DEFAULT }], [3]);
    expect(record).toMatchObject({ motor: 3, eepromVersion: 4, firmware: "2.21" });
    expect(Object.keys(record.raw)).toEqual(LAYOUTS[4].fields.map((f) => f.name));
    expect(record.raw.startup_power).toBe(V4_DEFAULT[25]);
    expect(record.shown.startup_power).toBe(`${V4_DEFAULT[25]} %`);
  });

  it("puts back the value every ESC holds, and refuses ESCs that differ", () => {
    const other = V4_DEFAULT.slice();
    other[25] = 120; // startup_power
    const escs = escRecords(
      [V4_DEFAULT, other].map((block, esc) => ({ esc, layout: LAYOUTS[4], block })),
      [1, 2],
    );
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
    const run = startRun(config, { gains: GAINS, esc: { pwm_frequency: 20 } }, null, null, 500);
    const ids = order(run);
    const blocks: [string, number][] = [];
    for (const id of ids) {
      const last = blocks[blocks.length - 1];
      if (last?.[0] === id) last[1]++;
      else blocks.push([id, 1]);
    }
    const [c16, c24, c32, c48] = startRun(config, BASE, null, null, 500).candidates.map((c) => c.id);
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
    expect(plannedRun(run)).toEqual({ sets: 60, writes: blocks.length - 1 });
  });

  it("without halving, runs every candidate's n sets as one block, baselines between", () => {
    const config = {
      ...DEFAULT_CONFIG,
      grid: grid({ pwm_frequency: [16, 24, 32, 48] }),
      n: 20,
      halving: false,
    };
    const run = startRun(config, { gains: GAINS, esc: { pwm_frequency: 20 } }, null, null, 500);
    const ids = order(run);
    const [c16, c24, c32, c48] = run.candidates.map((c) => c.id);
    const blocks = ids.filter((id, i) => id !== ids[i - 1]);
    expect(blocks).toEqual([BASELINE, c16, c24, BASELINE, c32, c48, BASELINE]);
    expect(plannedRun(run)).toEqual({ sets: 80, writes: blocks.length - 1 });
  });
});

describe("the overshoot limit", () => {
  /** The run's ranking once every set it asks for has run, a candidate's sets all alike. */
  function ranked(run: Run, outcome: (id: string) => [readyMs: number, overshootPct: number]) {
    let current = run;
    for (;;) {
      const { search, next } = nextSet(current);
      current = { ...current, search };
      if (next === null) break;
      const [readyMs, overshootPct] = next === BASELINE ? [300, 0] : outcome(next);
      const spinups = [{ ...spinup(readyMs), overshootPct }];
      current = { ...current, sets: [...current.sets, { id: next, at: 0, spinups }] };
    }
    return ranking(current.search, scoresOf(current), overshootLimit(current.config.grid));
  }

  it("lets an ESC run's fastest candidate win however far it overshoots", () => {
    const field = LAYOUTS[4].fields.find((f) => f.name === "pwm_frequency")!;
    const values = [48, 96].map((pwm_frequency) => ({ pwm_frequency }));
    const grid: EscGrid = { kind: "esc", fields: [{ field, values }] };
    const baseline = { gains: GAINS, esc: { pwm_frequency: 24 } };
    const run = startRun({ ...DEFAULT_CONFIG, grid, n: 3 }, baseline, null, null, 500);
    const [fast, steady] = run.candidates.map((c) => c.id);
    const rows = ranked(run, (id) => (id === fast ? [112, 4.5] : [248, 2.4]));
    expect(rows.map((r) => [r.id, r.standing.qualified])).toEqual([
      [fast, true],
      [steady, true],
    ]);
    expect(rows[0].standing.overshootPct).toBe(4.5);
  });

  it("rules out a gains candidate whose overshoot passes the limit", () => {
    const grid = { ...DEFAULT_GAINS, kp: [0.1, 0.2], ki: [1], overshootLimitPct: 3 };
    const run = startRun({ ...DEFAULT_CONFIG, grid, n: 3 }, BASE, null, null, 500);
    const [fast, steady] = run.candidates.map((c) => c.id);
    const rows = ranked(run, (id) => (id === fast ? [112, 4.5] : [248, 2.4]));
    expect(rows.map((r) => [r.id, r.standing.qualified])).toEqual([
      [steady, true],
      [fast, false],
    ]);
  });
});

describe("the candidate with the baseline's settings", () => {
  const field = LAYOUTS[4].fields.find((f) => f.name === "pwm_frequency")!;
  const config = {
    ...DEFAULT_CONFIG,
    grid: {
      kind: "esc" as const,
      fields: [{ field, values: [16, 24, 32, 48].map((pwm_frequency) => ({ pwm_frequency })) }],
    },
    n: 20,
    halving: false,
  };
  const runOn = (pwm: number) =>
    startRun(config, { gains: GAINS, esc: { pwm_frequency: pwm } }, null, null, 500);

  it("is one with the baseline: its sets count, so it runs fewer and is written for none", () => {
    const run = runOn(24);
    const [c16, c24, c32, c48] = run.candidates.map((c) => c.id);
    expect(startingId(run)).toBe(c24);
    expect(startingId(runOn(20))).toBeNull();
    const ids = order(run);
    const blocks: [string, number][] = [];
    for (const id of ids) {
      const last = blocks[blocks.length - 1];
      if (last?.[0] === id) last[1]++;
      else blocks.push([id, 1]);
    }
    // c24, with the most sets already, goes last, by when two baseline blocks are 6 of its 20.
    // Baseline blocks still come every 24 candidate sets, as 3, and close the run.
    expect(blocks).toEqual([
      [BASELINE, 3],
      [c16, 20],
      [c32, 20],
      [BASELINE, 3],
      [c48, 20],
      [c24, 14],
      [BASELINE, 3],
    ]);
    // c24 to the baseline is no write: 5, where 6 would be.
    expect(plannedRun(run)).toEqual({ sets: 74, writes: 5 });
    expect(plannedRun(runOn(20))).toEqual({ sets: 80, writes: 6 });
  });

  it("ranks on exactly n of its sets, the baseline's among them", () => {
    let run = runOn(24);
    for (const id of order(run)) {
      run = { ...run, sets: [...run.sets, { id, at: 0, spinups: [spinup(100)] }] };
    }
    const c24 = startingId(run)!;
    expect(scoresOf(run)[c24]).toHaveLength(23);
    const rows = ranking(run.search, scoresOf(run), null);
    expect(rows.find((r) => r.id === c24)!.standing.sets).toBe(20);
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
    const s = measure(
      { csv, report: { readyMs: 3, slowestMotor: 3, timedOut: false } },
      30000,
      "a.csv",
      3,
    );
    expect(s).toMatchObject({ rpm: 30000, readyMs: 3, overshootPct: 2, packMv: 16400 });
  });

  it("keeps each motor's RPM over the first traceMs, one sample in TRACE_STEP", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `16400,${i * 100},30000,1999,0.00,${i * 90},30000,1999,0.00,`,
    );
    const long = [csv.split("\n")[0], ...rows].join("\n");
    const report = { readyMs: 3, slowestMotor: 3, timedOut: false };
    expect(TRACE_STEP).toBe(5);
    expect(measure({ csv: long, report }, 30000, "a.csv", 11).trace).toEqual([
      [0, 500, 1000],
      [0, 450, 900],
    ]);
  });

  it("refuses a capture that did not start from rest at the RPM asked for", () => {
    const report = { readyMs: 3, slowestMotor: 3, timedOut: false };
    const spinning = csv.replace("16400,0,30000", "16400,12000,30000");
    expect(() => measure({ csv: spinning, report }, 30000, "a.csv", 3)).toThrow(/motor 1 at 12000 RPM/);
    expect(() => measure({ csv, report }, 25000, "a.csv", 3)).toThrow(/aiming for 30000/);
  });
});
