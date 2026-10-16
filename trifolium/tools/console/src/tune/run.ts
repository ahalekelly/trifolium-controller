// A spin-up search run: what it searches, what it has measured, and what to run next.
//
// A run searches one of two things. A gains run tries flywheel gains, which TUNE sets in RAM for a
// spin-up. An ESC run tries AM32 settings, written to every flywheel ESC's flash, and spins up on the
// blaster's own gains. Flash wears out, so an ESC run gives each candidate its sets for a round as
// one block after one write, where a gains run takes its candidates in turn.
//
// Plain data throughout, so a run survives a reload or a disconnect in localStorage and exports as
// JSON as it stands. The search itself (search.ts) sees only candidate ids and set scores.

import { shown, type EscField } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import { parseRpmCsv, wholeRows } from "../rpm/parse";
import { getByKey } from "../schema/keyPath";
import type { Capture } from "../serial/transport";
import { plan, planned, startSearch, type Search, type SetScore } from "./search";

export type Control = "pid" | "tbh";

/** What TUNE sets: TBH takes ki as its gain, and kp rides along unused. */
export interface Gains {
  control: Control;
  kp: number;
  ki: number;
}

/** A gains run's candidates: PID's are every kp with every ki, TBH's its gains. */
export interface GainsGrid {
  kind: "gains";
  mode: Control | "both";
  kp: number[];
  ki: number[];
  tbh: number[];
}

/** An ESC run's candidates: every combination of the values listed, raw, for each field. */
export interface EscGrid {
  kind: "esc";
  fields: { field: EscField; values: number[] }[];
}

export interface TuneConfig {
  grid: GainsGrid | EscGrid;
  rpms: number[];
  /** Sets each finalist gets; its second-worst is the 95th percentile at the default 20. */
  n: number;
  overshootLimitPct: number;
  /** The run pauses for a pack swap once a cell reads below this at the start of a spin-up. */
  pauseCellMv: number;
}

export const DEFAULT_GAINS: GainsGrid = {
  kind: "gains",
  mode: "pid",
  kp: [0.1, 0.2, 0.4],
  ki: [0.25, 0.5, 1],
  tbh: [0.05, 0.1, 0.2],
};

export const DEFAULT_CONFIG: TuneConfig = {
  grid: DEFAULT_GAINS,
  rpms: [30000],
  n: 20,
  overshootLimitPct: 3,
  pauseCellMv: 3600,
};

/** AM32 settings, raw by field name, as writeEscSettings() takes them. */
export type EscValues = Record<string, number>;

/**
 * What a set runs on: the gains TUNE sends with each RPM, and the settings every flywheel ESC holds
 * for it - null in a gains run, which leaves the ESCs alone.
 */
export interface Settings {
  gains: Gains;
  esc: EscValues | null;
}

export interface Candidate extends Settings {
  /** Also its label. */
  id: string;
}

/** One spin-up, at one RPM. readyMs is null when the rampup timeout ended it. */
export interface Spinup {
  rpm: number;
  readyMs: number | null;
  overshootPct: number;
  /** At the rev's start, so the pack at rest. */
  packMv: number;
}

/** The id of the settings the blaster started with, run between candidates to show drift. */
export const BASELINE = "baseline";

export interface SetRecord {
  /** A candidate's id, or BASELINE. */
  id: string;
  at: number;
  spinups: Spinup[];
}

export type RunStatus = "running" | "paused" | "done";

/** Changes whenever Run's shape does, so a run another build saved is refused rather than misread. */
const RUN_VERSION = 2;

export interface Run {
  version: typeof RUN_VERSION;
  config: TuneConfig;
  /** What the blaster started with, which an ESC run puts back on the ESCs when it stops. */
  baseline: Settings;
  candidates: Candidate[];
  search: Search;
  sets: SetRecord[];
  /** Per candidate, its latest set's slowest motor's RPM at each target, for the finalists chart. */
  traces: Record<string, number[][]>;
  status: RunStatus;
  /** Why it is paused. */
  note: string | null;
  /** How many times the run has written the ESCs, each at most one flash erase per ESC. */
  escWrites: number;
  /**
   * The ESCs may hold a candidate's settings, so the baseline's are owed back: set before a
   * candidate's write, cleared once the baseline's or an applied winner's verifies.
   */
  restoreEscs: boolean;
}

/**
 * Baseline sets come in blocks of `size`, once `every` candidate sets have run since the last, and
 * never inside a candidate's block. Each of a gains run's sets is a block of its own. An ESC run
 * pays a write for each baseline block, so its blocks are bigger and further apart, for the same
 * share of the run.
 */
const BASELINE_BLOCKS = { gains: { size: 1, every: 8 }, esc: { size: 3, every: 24 } };

export const gainsLabel = (g: Gains) =>
  g.control === "pid" ? `PID kp ${g.kp} ki ${g.ki}` : `TBH gain ${g.ki}`;

const escLabel = (grid: EscGrid, values: EscValues) =>
  grid.fields.map(({ field }) => `${field.label} ${shown(field, values[field.name])}`).join(", ");

/** What a candidate or the baseline sets, as the results show it. */
export const settingsLabel = (grid: TuneConfig["grid"], settings: Settings) =>
  grid.kind === "esc" ? escLabel(grid, settings.esc!) : gainsLabel(settings.gains);

/**
 * The gains the blaster runs on now, as one set for every motor: its control mode and the first
 * enabled motor's gains. Null with no motor enabled.
 */
export function baselineOf(device: unknown): Gains | null {
  const motors = getByKey(device, "device:motorConfig") as MotorGains[];
  const first = motors.find((m) => m.enabled);
  if (!first) return null;
  const control = getByKey(device, "device:flywheelControl") as Control;
  return { control, kp: first.kp, ki: first.ki };
}

type MotorGains = { enabled: boolean; kp: number; ki: number };

/**
 * Every candidate a grid describes. TBH candidates keep the baseline's kp, which TBH never reads,
 * and ESC candidates spin up on the baseline's gains.
 */
export function candidatesFor(grid: TuneConfig["grid"], baseline: Settings): Candidate[] {
  const all: Settings[] = [];
  if (grid.kind === "esc") {
    let combos: EscValues[] = [{}];
    for (const { field, values } of grid.fields) {
      combos = combos.flatMap((combo) => values.map((v) => ({ ...combo, [field.name]: v })));
    }
    for (const esc of combos) all.push({ gains: baseline.gains, esc });
  } else {
    if (grid.mode !== "tbh") {
      for (const kp of grid.kp) {
        for (const ki of grid.ki) all.push({ gains: { control: "pid", kp, ki }, esc: null });
      }
    }
    if (grid.mode !== "pid") {
      for (const ki of grid.tbh) {
        all.push({ gains: { control: "tbh", kp: baseline.gains.kp, ki }, esc: null });
      }
    }
  }
  // A value listed twice is one candidate.
  const byId = new Map(all.map((s) => [settingsLabel(grid, s), s]));
  return [...byId].map(([id, s]) => ({ id, ...s }));
}

/**
 * The value every ESC holds for each field an ESC grid searches, which the run puts back. ESCs that
 * differ on one have no single value to put back, so they are refused.
 */
export function escOriginals(escs: EscSettings[], grid: EscGrid): EscValues {
  const values: EscValues = {};
  for (const { field } of grid.fields) {
    const raws = escs.map(({ esc, layout, block }) => {
      const own = layout.fields.find((f) => f.name === field.name);
      if (!own) throw new Error(`ESC ${esc}'s settings layout ${layout.version} lacks ${field.label}.`);
      return block[own.offset];
    });
    if (new Set(raws).size > 1) {
      throw new Error(
        `The ESCs differ on ${field.label} (${raws.map((r) => shown(field, r)).join(", ")}). ` +
          "Write one value to all of them on the ESCs tab, so the run has one to put back.",
      );
    }
    values[field.name] = raws[0];
  }
  return values;
}

/**
 * At most how many ESC writes an ESC run of `count` candidates takes: one per candidate block, and
 * one per baseline block after the first, which the run's opening read leaves the ESCs on. A
 * candidate that ends one round and opens the next is not written again, and a run that pauses
 * writes twice more: the baseline's settings back, then the candidate's again on Resume.
 */
export function plannedEscWrites(count: number, n: number): number {
  const { sets, blocks } = planned(count, n);
  return blocks + Math.floor(sets / BASELINE_BLOCKS.esc.every) + 1;
}

export function startRun(config: TuneConfig, baseline: Settings): Run {
  const candidates = candidatesFor(config.grid, baseline);
  return {
    version: RUN_VERSION,
    config,
    baseline,
    candidates,
    search: startSearch(
      candidates.map((c) => c.id),
      config.n,
    ),
    sets: [],
    traces: {},
    status: "running",
    note: null,
    escWrites: 0,
    restoreEscs: false,
  };
}

export function scoreOf(set: SetRecord): SetScore {
  return {
    timedOut: set.spinups.some((s) => s.readyMs === null),
    ms: set.spinups.reduce((sum, s) => sum + (s.readyMs ?? 0), 0),
    overshootPct: Math.max(...set.spinups.map((s) => s.overshootPct)),
  };
}

/** Each candidate's set scores, in the order they ran. */
export function scoresOf(run: Run): Record<string, SetScore[]> {
  const scores: Record<string, SetScore[]> = {};
  for (const set of run.sets) (scores[set.id] ??= []).push(scoreOf(set));
  return scores;
}

/**
 * What to run a set of next - a candidate's id or BASELINE - with the search moved on past any round
 * that is complete; null once the run is over. The run opens and closes on a baseline block and has
 * them between, as BASELINE_BLOCKS says, so drift shows against the same settings throughout.
 */
export function nextSet(run: Run): { search: Search; next: string | null } {
  const { kind } = run.config.grid;
  const ids = run.sets.map((s) => s.id);
  let lastCandidate = ids.length - 1;
  while (lastCandidate >= 0 && ids[lastCandidate] === BASELINE) lastCandidate--;
  const stay = kind === "esc" && lastCandidate >= 0 ? ids[lastCandidate] : null;
  const { search, next } = plan(run.search, scoresOf(run), run.config.overshootLimitPct, stay);

  const { size, every } = BASELINE_BLOCKS[kind];
  const baselineSets = ids.length - 1 - lastCandidate; // the block the run ends on so far
  const sinceBaseline = ids.length - 1 - ids.lastIndexOf(BASELINE);
  const between = next === null ? sinceBaseline > 0 : sinceBaseline >= every && next !== stay;
  if (ids.length === 0 || (baselineSets > 0 && baselineSets < size) || between) {
    return { search, next: BASELINE };
  }
  return { search, next };
}

/** A stopped motor's telemetry reads 0; a capture that starts above this did not start from rest. */
const REST_RPM = 500;

/**
 * Reads a spin-up off its capture: the firmware's own fire-ready time, and how far the worst motor
 * went past `rpm` once it first got there, as % of `rpm`. `traceMs` is how much of the slowest
 * motor's RPM to keep for the chart. A capture that did not start from rest at `rpm` is some other
 * rev's - the trigger, the Rev switch, a hold that lapsed and came back - and is refused.
 */
export function measure(
  capture: Capture,
  rpm: number,
  traceMs: number,
): { spinup: Spinup; trace: number[] } {
  const log = parseRpmCsv(wholeRows(capture.csv).csv);
  if (!log.motors.length || !log.voltage.length) {
    throw new Error("The capture has no motor or pack voltage columns.");
  }
  for (const motor of log.motors) {
    if (motor.rpm[0] > REST_RPM || motor.targetRpm[0] !== rpm) {
      throw new Error(
        `The capture started with motor ${motor.index} at ${motor.rpm[0]} RPM aiming for ` +
          `${motor.targetRpm[0]}, not from rest aiming for ${rpm}: something else revved the ` +
          "blaster.",
      );
    }
  }
  let overshootPct = 0;
  for (const motor of log.motors) {
    const reached = motor.rpm.findIndex((v) => v >= rpm);
    if (reached < 0) continue;
    const peak = Math.max(...motor.rpm.slice(reached));
    overshootPct = Math.max(overshootPct, ((peak - rpm) / rpm) * 100);
  }
  const slowest =
    log.motors.find((m) => m.index === capture.report.slowestMotor) ?? log.motors[0];
  return {
    spinup: {
      rpm,
      readyMs: capture.report.readyMs,
      overshootPct,
      packMv: log.voltage[0],
    },
    trace: slowest.rpm.slice(0, traceMs),
  };
}

const STORAGE_KEY = "trifolium.tune";

/** The run left in this browser: none, or one another build saved and this one cannot read. */
export type Saved = Run | null | "unreadable";

/**
 * The run left in this browser. One that was running when the page went away comes back paused:
 * nothing is driving the blaster now.
 */
export function loadRun(): Saved {
  const text = localStorage.getItem(STORAGE_KEY);
  if (!text) return null;
  const run = JSON.parse(text) as Run | null;
  if (run?.version !== RUN_VERSION) return "unreadable";
  return run.status === "running"
    ? { ...run, status: "paused", note: "The console was closed mid-run. Resume to carry on." }
    : run;
}

export function saveRun(run: Run | null) {
  if (run) localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
  else localStorage.removeItem(STORAGE_KEY);
}
