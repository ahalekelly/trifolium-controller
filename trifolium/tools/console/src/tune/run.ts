// A gains run: what it searches, what it has measured, and what to run next.
//
// Plain data throughout, so a run survives a reload or a disconnect in localStorage and exports as
// JSON as it stands. The search itself (search.ts) sees only candidate ids and set scores.

import { parseRpmCsv, wholeRows } from "../rpm/parse";
import { getByKey } from "../schema/keyPath";
import type { Capture } from "../serial/transport";
import { plan, startSearch, type Search, type SetScore } from "./search";

export type Control = "pid" | "tbh";

/** What TUNE sets: TBH takes ki as its gain, and kp rides along unused. */
export interface Gains {
  control: Control;
  kp: number;
  ki: number;
}

export interface TuneConfig {
  mode: Control | "both";
  /** PID's grid is every kp with every ki. */
  kp: number[];
  ki: number[];
  /** TBH's gains. */
  tbh: number[];
  rpms: number[];
  /** Sets each finalist gets; its second-worst is the 95th percentile at the default 20. */
  n: number;
  overshootLimitPct: number;
  /** The run pauses for a pack swap once a cell reads below this at the start of a spin-up. */
  pauseCellMv: number;
}

export const DEFAULT_CONFIG: TuneConfig = {
  mode: "pid",
  kp: [0.1, 0.2, 0.4],
  ki: [0.25, 0.5, 1],
  tbh: [0.05, 0.1, 0.2],
  rpms: [30000],
  n: 20,
  overshootLimitPct: 3,
  pauseCellMv: 3600,
};

export interface Candidate {
  /** Also its label. */
  id: string;
  gains: Gains;
}

/** One spin-up, at one RPM. readyMs is null when the rampup timeout ended it. */
export interface Spinup {
  rpm: number;
  readyMs: number | null;
  overshootPct: number;
  /** At the rev's start, so the pack at rest. */
  packMv: number;
}

/** The settings the blaster started with, run between candidates to show drift. */
export const BASELINE = "baseline";

export interface SetRecord {
  /** A candidate's id, or BASELINE. */
  id: string;
  at: number;
  spinups: Spinup[];
}

export type RunStatus = "running" | "paused" | "done";

/** Changes whenever Run's shape does, so a run another build saved is refused rather than misread. */
const RUN_VERSION = 1;

export interface Run {
  version: typeof RUN_VERSION;
  config: TuneConfig;
  baseline: Gains;
  candidates: Candidate[];
  search: Search;
  sets: SetRecord[];
  /** Per candidate, its latest set's slowest motor's RPM at each target, for the finalists chart. */
  traces: Record<string, number[][]>;
  status: RunStatus;
  /** Why it is paused. */
  note: string | null;
}

/** A baseline set after every this many candidate sets. */
const BASELINE_EVERY = 8;

export const gainsLabel = (g: Gains) =>
  g.control === "pid" ? `PID kp ${g.kp} ki ${g.ki}` : `TBH gain ${g.ki}`;

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

/** TBH candidates keep the baseline's kp, which TBH never reads. */
export function candidatesFor(config: TuneConfig, baseline: Gains): Candidate[] {
  const gains: Gains[] = [];
  if (config.mode !== "tbh") {
    for (const kp of config.kp) for (const ki of config.ki) gains.push({ control: "pid", kp, ki });
  }
  if (config.mode !== "pid") {
    for (const ki of config.tbh) gains.push({ control: "tbh", kp: baseline.kp, ki });
  }
  // A value listed twice is one candidate.
  const byId = new Map(gains.map((g) => [gainsLabel(g), g]));
  return [...byId].map(([id, g]) => ({ id, gains: g }));
}

export function startRun(config: TuneConfig, baseline: Gains): Run {
  const candidates = candidatesFor(config, baseline);
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
 * that is complete; null once the run is over. The run opens and closes on a baseline set and has
 * one every BASELINE_EVERY candidate sets between, so drift shows against the same settings
 * throughout.
 */
export function nextSet(run: Run): { search: Search; next: string | null } {
  const { search, next } = plan(run.search, scoresOf(run), run.config.overshootLimitPct);
  const lastBaseline = run.sets.map((s) => s.id).lastIndexOf(BASELINE);
  const sinceBaseline = run.sets.length - 1 - lastBaseline;
  if (lastBaseline < 0 || (next !== null && sinceBaseline >= BASELINE_EVERY)) {
    return { search, next: BASELINE };
  }
  if (next === null && sinceBaseline > 0) return { search, next: BASELINE };
  return { search, next };
}

/**
 * Reads a spin-up off its capture: the firmware's own fire-ready time, and how far the worst motor
 * went past `rpm` once it first got there, as % of `rpm`. `traceMs` is how much of the slowest
 * motor's RPM to keep for the chart.
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
