import { readFileSync } from "node:fs";
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
  escNames,
  escRecords,
  measure,
  nextSet,
  rankingOf,
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
  reachMs: readyMs,
  overshootPct: 1,
  packMv: 16000,
  desync: null,
  trace: [],
});

/** Ids as blocks: each with how many sets in a row it ran. */
function blocksOf(ids: string[]): [string, number][] {
  const blocks: [string, number][] = [];
  for (const id of ids) {
    const last = blocks[blocks.length - 1];
    if (last?.[0] === id) last[1]++;
    else blocks.push([id, 1]);
  }
  return blocks;
}

/** Runs every set nextSet() asks for, returning the ids in order. */
function order(run: Run): string[] {
  let current = run;
  const ids: string[] = [];
  for (;;) {
    const next = nextSet(current);
    if (next === null) return ids;
    ids.push(next);
    current = { ...current, sets: [...current.sets, { id: next, at: 0, spinups: [spinup(100)] }] };
  }
}

describe("a gains run", () => {
  it("grids PID's kp with ki, and gives TBH its gains on ki, each value once", () => {
    const both = { ...DEFAULT_GAINS, mode: "both" as const, kp: [0.1, 0.2, 0.1], ki: [0.5], tbh: [0.05] };
    expect(candidatesFor(both, BASE)).toEqual([
      { id: "PID kp 0.1 ki 0.5", name: "PID kp 0.1 ki 0.5", gains: { control: "pid", kp: 0.1, ki: 0.5 }, esc: null },
      { id: "PID kp 0.2 ki 0.5", name: "PID kp 0.2 ki 0.5", gains: { control: "pid", kp: 0.2, ki: 0.5 }, esc: null },
      { id: "TBH gain 0.05", name: "TBH gain 0.05", gains: { control: "tbh", kp: 0.2, ki: 0.05 }, esc: null },
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

  it("opens and closes on 3 baseline sets, and takes its candidates in turn between", () => {
    const grid = { ...DEFAULT_GAINS, kp: [0.1, 0.2, 0.4], ki: [0.25, 0.5, 1] };
    const ids = order(startRun({ ...DEFAULT_CONFIG, grid, n: 3 }, BASE, null, null, 500));
    expect(ids.slice(0, 3)).toEqual([BASELINE, BASELINE, BASELINE]);
    expect(ids.slice(-3)).toEqual([BASELINE, BASELINE, BASELINE]);
    const between = ids.slice(3, -3);
    expect(between).not.toContain(BASELINE);
    expect(between.slice(0, 2)).toEqual(["PID kp 0.1 ki 0.25", "PID kp 0.1 ki 0.5"]);
    // 9 candidates of 3 sets, but kp 0.2 ki 0.5, the blaster's own, has its 3 from the baseline.
    expect(between).toHaveLength(24);
    expect(between).not.toContain("PID kp 0.2 ki 0.5");
  });

  it("scores a set on its summed spin-ups, a timed-out one at the rampup timeout", () => {
    const set = { id: "x", at: 0, spinups: [spinup(150), { ...spinup(200), overshootPct: 4 }] };
    const RUN = { config: { ...DEFAULT_CONFIG, rpms: [20000, 30000] }, rampupTimeoutMs: 500 };
    expect(scoreOf(set, RUN)).toEqual({ timedOut: false, ms: 350, overshootPct: 4, desync: null });
    const timedOut = scoreOf({ ...set, spinups: [spinup(150), spinup(null)] }, RUN);
    expect(timedOut).toMatchObject({ timedOut: true, ms: 650 });
    // Past the rampup timeout is a timeout too, at the timeout.
    const late = scoreOf({ ...set, spinups: [spinup(150), spinup(620)] }, RUN);
    expect(late).toMatchObject({ timedOut: true, ms: 650 });
    // A spin-up that lost sync is a timeout too, however soon it got to speed.
    const desync = { motor: 3, atMs: 123, minRpm: 289 };
    const lost = scoreOf({ ...set, spinups: [spinup(150), { ...spinup(70), desync }] }, RUN);
    expect(lost).toMatchObject({ timedOut: true, ms: 650, desync });
    // And so is each RPM it stopped short of.
    expect(scoreOf({ ...set, spinups: [{ ...spinup(70), desync }] }, RUN).ms).toBe(1000);
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
    expect(captureFile(run, run.candidates[0].id, 25000)).toBe(
      "tune-2026-11-05_14-50-37_set001_PID-kp-0.1-ki-0.25_25000rpm.csv",
    );
  });
});

describe("an ESC run", () => {
  const field = (name: string) => LAYOUTS[4].fields.find((f) => f.name === name)!;
  const grid = (values: Record<string, number[]>): EscGrid => ({
    kind: "esc", oneAtATime: false,
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
      kind: "esc", oneAtATime: false,
      fields: [{ field: pwm, values: [{ pwm_frequency: 32 }, byRpm] }],
    };
    expect(escNames(frequencies)).toEqual(["pwm_frequency", "variable_pwm"]);
    expect(candidatesFor(frequencies, { gains: GAINS, esc })).toEqual([
      {
        id: "PWM frequency 32 kHz",
        name: "PWM frequency 32 kHz",
        gains: GAINS,
        esc: { pwm_frequency: 32, variable_pwm: 0 },
      },
      {
        id: "PWM frequency By RPM",
        name: "PWM frequency By RPM",
        gains: GAINS,
        esc: { pwm_frequency: 24, variable_pwm: 2 },
      },
    ]);
    // By RPM ignores the PWM type, so crossing the two leaves one By RPM candidate.
    const crossed: EscGrid = {
      kind: "esc", oneAtATime: false,
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

  it("tries one setting at a time on the baseline, each named by what it changes", () => {
    const esc = { startup_power: 100, advance_level: 26 };
    const oneAtATime: EscGrid = {
      ...grid({ startup_power: [80, 100, 120], advance_level: [18, 26] }),
      oneAtATime: true,
    };
    const candidates = candidatesFor(oneAtATime, { gains: GAINS, esc });
    // 3 + 2 values, of which 100 % and 15 ° are both the baseline: 4 candidates, not 6.
    expect(candidates.map((c) => [c.id, c.name])).toEqual([
      ["Startup power 80 %, Timing advance 15 °", "Startup power 80 %"],
      ["Startup power 100 %, Timing advance 15 °", "Startup power 100 %, Timing advance 15 °"],
      ["Startup power 120 %, Timing advance 15 °", "Startup power 120 %"],
      ["Startup power 100 %, Timing advance 7.5 °", "Timing advance 7.5 °"],
    ]);
    const config = { ...DEFAULT_CONFIG, grid: oneAtATime };
    const run = startRun(config, { gains: GAINS, esc }, null, null, 500);
    expect(startingId(run)).toBe("Startup power 100 %, Timing advance 15 °");
    run.startedAt = new Date(2026, 10, 5, 14, 50, 37).getTime();
    expect(captureFile(run, "Startup power 80 %, Timing advance 15 °", 30000)).toBe(
      "tune-2026-11-05_14-50-37_set000_Startup-power-80_30000rpm.csv",
    );
    const everyConfig = { ...config, grid: { ...oneAtATime, oneAtATime: false } };
    const every = startRun(everyConfig, run.baseline, null, null, 500);
    expect(every.candidates).toHaveLength(6);
    expect(plannedRun(run).sets).toBeLessThan(plannedRun(every).sets);
    expect(plannedRun(run).writes).toBeLessThan(plannedRun(every).writes);
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

  it("runs each candidate's sets as one block, between the opening and closing baseline", () => {
    const config = { ...DEFAULT_CONFIG, grid: grid({ pwm_frequency: [16, 24, 32, 48] }), n: 20 };
    const run = startRun(config, { gains: GAINS, esc: { pwm_frequency: 20 } }, null, null, 500);
    const ids = order(run);
    const [c16, c24, c32, c48] = run.candidates.map((c) => c.id);
    expect(blocksOf(ids)).toEqual([
      [BASELINE, 3],
      [c16, 20],
      [c24, 20],
      [c32, 20],
      [c48, 20],
      [BASELINE, 3],
    ]);
    // Every block but the first is a write.
    expect(plannedRun(run)).toEqual({ sets: 80, writes: 5 });
  });
});

describe("the overshoot limit", () => {
  /** The run's ranking once every set it asks for has run, a candidate's sets all alike. */
  function ranked(run: Run, outcome: (id: string) => [readyMs: number, overshootPct: number]) {
    let current = run;
    for (;;) {
      const next = nextSet(current);
      if (next === null) break;
      const [readyMs, overshootPct] = next === BASELINE ? [300, 0] : outcome(next);
      const spinups = [{ ...spinup(readyMs), overshootPct }];
      current = { ...current, sets: [...current.sets, { id: next, at: 0, spinups }] };
    }
    return rankingOf(current);
  }

  it("lets an ESC run's fastest candidate win however far it overshoots", () => {
    const field = LAYOUTS[4].fields.find((f) => f.name === "pwm_frequency")!;
    const values = [48, 96].map((pwm_frequency) => ({ pwm_frequency }));
    const grid: EscGrid = { kind: "esc", oneAtATime: false, fields: [{ field, values }] };
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
      kind: "esc" as const, oneAtATime: false,
      fields: [{ field, values: [16, 24, 32, 48].map((pwm_frequency) => ({ pwm_frequency })) }],
    },
    n: 20,
  };
  const runOn = (pwm: number) =>
    startRun(config, { gains: GAINS, esc: { pwm_frequency: pwm } }, null, null, 500);

  it("is one with the baseline: its sets count, so it runs fewer and is written for none", () => {
    const run = runOn(24);
    const [c16, c24, c32, c48] = run.candidates.map((c) => c.id);
    expect(startingId(run)).toBe(c24);
    expect(startingId(runOn(20))).toBeNull();
    // c24, with the opening block's 3 already, goes last and needs 17 of its own.
    expect(blocksOf(order(run))).toEqual([
      [BASELINE, 3],
      [c16, 20],
      [c32, 20],
      [c48, 20],
      [c24, 17],
      [BASELINE, 3],
    ]);
    // c24 to the closing baseline is no write: 4, where 5 would be.
    expect(plannedRun(run)).toEqual({ sets: 77, writes: 4 });
    expect(plannedRun(runOn(20))).toEqual({ sets: 80, writes: 5 });
  });

  it("ranks on exactly n of its sets, the baseline's among them", () => {
    let run = runOn(24);
    for (const id of order(run)) {
      run = { ...run, sets: [...run.sets, { id, at: 0, spinups: [spinup(100)] }] };
    }
    const c24 = startingId(run)!;
    expect(scoresOf(run)[c24]).toHaveLength(23);
    const rows = rankingOf(run);
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
      { csv, report: { readyMs: 3, slowestMotor: 3, timedOut: false, maxThrottle: 1999 } },
      30000,
      "a.csv",
      3,
    );
    // Both motors are past 80% of target by the second sample.
    expect(s).toMatchObject({ rpm: 30000, readyMs: 3, reachMs: 1, overshootPct: 2, packMv: 16400 });
  });

  it("keeps each motor's RPM over the first traceMs, one sample in TRACE_STEP", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `16400,${i * 100},30000,1999,0.00,${i * 90},30000,1999,0.00,`,
    );
    const long = [csv.split("\n")[0], ...rows].join("\n");
    const report = { readyMs: 3, slowestMotor: 3, timedOut: false, maxThrottle: 1999 };
    expect(TRACE_STEP).toBe(5);
    expect(measure({ csv: long, report }, 30000, "a.csv", 11).trace).toEqual([
      { rpm: [0, 500, 1000], full: [[0, 3]] },
      { rpm: [0, 450, 900], full: [[0, 3]] },
    ]);
  });

  it("keeps where each motor ran at full throttle, and times the slower to 80% of target", () => {
    // Motor 1 backs off from full throttle at sample 6; motor 3 reaches 24000 RPM at sample 4,
    // motor 1 at sample 3.
    const rows = Array.from({ length: 12 }, (_, i) => {
      const throttle1 = i < 6 ? 1999 : 1500;
      return `16400,${i * 8000},30000,${throttle1},0.00,${i * 6000},30000,1999,0.00,`;
    });
    rows[0] = "16400,0,30000,1999,0.00,0,30000,1999,0.00,";
    const long = [csv.split("\n")[0], ...rows].join("\n");
    const report = { readyMs: 9, slowestMotor: 3, timedOut: false, maxThrottle: 1999 };
    const s = measure({ csv: long, report }, 30000, "a.csv", 12);
    expect(s.reachMs).toBe(4);
    expect(s.trace.map((m) => m.full)).toEqual([[[0, 2]], [[0, 3]]]);
    // A motor that never gets there leaves no time.
    const stuck = rows.map((row) => row.replace(/,\d+,30000,1999,0\.00,$/, ",0,30000,1999,0.00,"));
    const slow = [csv.split("\n")[0], ...stuck].join("\n");
    expect(measure({ csv: slow, report }, 30000, "a.csv", 12).reachMs).toBeNull();
  });

  it("refuses a capture that did not start from rest at the RPM asked for", () => {
    const report = { readyMs: 3, slowestMotor: 3, timedOut: false, maxThrottle: 1999 };
    const spinning = csv.replace("16400,0,30000", "16400,12000,30000");
    expect(() => measure({ csv: spinning, report }, 30000, "a.csv", 3)).toThrow(/motor 2 at 12000 RPM/);
    expect(() => measure({ csv, report }, 25000, "a.csv", 3)).toThrow(/aiming for 30000/);
  });
});

describe("a motor losing sync", () => {
  const report = { readyMs: 60, slowestMotor: 3, timedOut: false, maxThrottle: 1999 };
  const fixture = (name: string) => readFileSync(new URL(`testdata/${name}`, import.meta.url), "utf8");
  const desyncOf = (csv: string) => measure({ csv, report }, 20000, "a.csv", 0).desync;

  it("is found in real captures, by when it first fell and how low it went", () => {
    // Motor 3 got to 16k RPM, then fell again and again, once to 289 RPM, at full throttle.
    expect(desyncOf(fixture("desync-motor3.csv"))).toEqual({ motor: 3, atMs: 123, minRpm: 289 });
    expect(desyncOf(fixture("desync-motor1.csv"))).toMatchObject({ motor: 1, atMs: 65 });
    expect(desyncOf(fixture("in-sync.csv"))).toBeNull();
  });

  it("is a fall below 70% of target lasting 10 ms, once the motor reached 90%, until release", () => {
    const head = "Voltage_mv,Motor 0,TargetRPM 0,Throttle 0,value 0,";
    const rev = (rpms: number[], released = rpms.length) =>
      [head, ...rpms.map((r, i) => `16400,${r},${i < released ? 20000 : 0},1999,0.00,`)].join("\n");
    const at = (n: number, rpm: number) => Array<number>(n).fill(rpm);
    const fall = (ms: number) => [0, ...at(5, 18000), ...at(ms, 13900), ...at(5, 20000)];
    expect(desyncOf(rev(fall(10)))).toEqual({ motor: 1, atMs: 6, minRpm: 13900 });
    expect(desyncOf(rev(fall(9)))).toBeNull(); // a glitch
    // Not before it got to speed, nor after the rev let go.
    expect(desyncOf(rev([0, ...at(20, 13900), ...at(5, 18000)]))).toBeNull();
    expect(desyncOf(rev(fall(10), 7))).toBeNull();
  });
});
