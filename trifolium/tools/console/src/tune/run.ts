// A spin-up search run: what it searches, what it has measured, and what to run next.
//
// A run searches one of two things. A gains run tries flywheel gains, which TUNE sets in RAM for a
// spin-up. An ESC run tries AM32 settings, written to every flywheel ESC's flash, and spins up on the
// blaster's own gains. Flash wears out, so an ESC run gives each candidate its sets for a round as
// one block after one write, where a gains run takes its candidates in turn.
//
// Plain data throughout, so a run survives a reload or a disconnect in localStorage and exports as
// JSON as it stands. The search itself (search.ts) sees only candidate ids and set scores.

import { fileStamp } from "../rpm/files";
import { firmwareOf, LAYOUTS, shown, type EscField } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import { MS_PER_SAMPLE, parseRpmCsv, wholeRows } from "../rpm/parse";
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

/** A gains run's candidates: PID's are every kp with every ki, TBH's its gains. */
export interface GainsGrid {
  kind: "gains";
  mode: Control | "both";
  kp: number[];
  ki: number[];
  tbh: number[];
  /**
   * A candidate whose second-worst overshoot passes this, % of target, cannot win. Only gains have
   * one: overshoot is Trifolium's speed control's doing, not the ESCs'.
   */
  overshootLimitPct: number;
}

/**
 * An ESC run's candidates: every combination of the values listed for each field. A value is the
 * raw writes it makes, by field name: the field's own, or what its `instead` writes.
 */
export interface EscGrid {
  kind: "esc";
  fields: { field: EscField; values: EscValues[] }[];
  /** Each candidate the baseline with one field changed, rather than every combination. */
  oneAtATime: boolean;
}

export interface TuneConfig {
  grid: GainsGrid | EscGrid;
  rpms: number[];
  /** Sets each finalist gets; its second-worst is the 95th percentile at the default 20. */
  n: number;
  /** Halve the candidates down to finalists, or give every candidate its n sets. */
  halving: boolean;
  /** The run pauses for a pack swap once a cell reads below this at the start of a spin-up. */
  pauseCellMv: number;
}

export const DEFAULT_GAINS: GainsGrid = {
  kind: "gains",
  mode: "pid",
  kp: [0.1, 0.2, 0.4],
  ki: [0.25, 0.5, 1],
  tbh: [0.05, 0.1, 0.2],
  overshootLimitPct: 3,
};

export const DEFAULT_CONFIG: TuneConfig = {
  grid: DEFAULT_GAINS,
  rpms: [30000],
  n: 20,
  halving: true,
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

/**
 * Everything one flywheel ESC held as an ESC run started. A candidate's full settings on it are
 * `raw` with the candidate's own `esc` values over it.
 */
export interface EscRecord {
  /** The 1-based motor it drives. */
  motor: number;
  /** Its block's eeprom_version, which names the layout. */
  eepromVersion: number;
  /** The AM32 version it reports, e.g. "2.21". */
  firmware: string;
  /** Every field its layout names, raw by field name, as writes take them. */
  raw: EscValues;
  /** The same, as the console shows them. */
  shown: Record<string, string>;
}

export interface Candidate extends Settings {
  /** Also its label. */
  id: string;
}

/**
 * A spin-up's trace keeps one capture sample in this many: 5 ms apart, a few hundred points a motor,
 * so a run's every trace fits in localStorage. Its CSV file has them all.
 */
export const TRACE_STEP = 5;

/** One motor's part of a spin-up's trace, one capture sample in TRACE_STEP from the rev's start. */
export interface MotorTrace {
  rpm: number[];
  /** Where it ran at full throttle, as [from, to) in `rpm`'s samples. */
  full: [number, number][];
}

/** How far up an ESC run times a spin-up: the slower wheel first reaching this share of target. */
export const ESC_REACH = 0.8;

/** One spin-up, at one RPM. readyMs is null when the rampup timeout ended it. */
export interface Spinup {
  rpm: number;
  /** The capture's CSV file - see captureFile(). */
  file: string;
  readyMs: number | null;
  /** When every motor had first reached ESC_REACH of `rpm`; null when one never did. */
  reachMs: number | null;
  overshootPct: number;
  /** At the rev's start, so the pack at rest. */
  packMv: number;
  trace: MotorTrace[];
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

/**
 * Changes whenever Run's shape or how its sets count does, so a run another build saved is refused
 * rather than misread.
 */
const RUN_VERSION = 8;

export interface Run {
  version: typeof RUN_VERSION;
  /** When it started, in ms since the epoch: every file it saves is named from it. */
  startedAt: number;
  /**
   * The chip ID of the blaster it started on, the one it runs on and owes ESC settings to; null from
   * firmware that does not report one.
   */
  blaster: string | null;
  config: TuneConfig;
  /** What the blaster started with, which an ESC run puts back on the ESCs when it stops. */
  baseline: Settings;
  /** What every flywheel ESC held as an ESC run started, in motor order; null in a gains run. */
  escs: EscRecord[] | null;
  /** The blaster's rampup timeout as the run started: a timed-out spin-up counts at it. */
  rampupTimeoutMs: number;
  candidates: Candidate[];
  search: Search;
  sets: SetRecord[];
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
  /** The winner is applied: stored on the run's own blaster, so there is nothing left to apply. */
  applied: boolean;
}

/**
 * Baseline sets come in blocks of `size`, once `every` candidate sets have run since the last, and
 * never inside a candidate's block. Each of a gains run's sets is a block of its own. An ESC run
 * pays a write for each baseline block, so its blocks are bigger and further apart, for the same
 * share of the run.
 */
const BASELINE_BLOCKS = { gains: { size: 1, every: 8 }, esc: { size: 3, every: 24 } };

/** The overshoot a candidate may not pass, % of target; null in an ESC run, which has none. */
export const overshootLimit = (grid: TuneConfig["grid"]): number | null =>
  grid.kind === "gains" ? grid.overshootLimitPct : null;

export const gainsLabel = (g: Gains) =>
  g.control === "pid" ? `PID kp ${g.kp} ki ${g.ki}` : `TBH gain ${g.ki}`;

/** The run's files: tune-<start>.json for its export, and its captures alongside. */
export const runName = (run: Run) => `tune-${fileStamp(new Date(run.startedAt))}`;

/**
 * The CSV file the next set's capture at `rpm` is saved as: the run, the set's index in `sets`, what
 * it ran - the baseline with its gains or ESC settings - and the RPM, e.g.
 * tune-2026-11-05_14-50-37_set004_PID-kp-0.2-ki-1_30000rpm.csv.
 */
export function captureFile(run: Run, id: string, rpm: number): string {
  const label = id === BASELINE ? `${BASELINE} ${settingsLabel(run.config.grid, run.baseline)}` : id;
  const set = String(run.sets.length).padStart(3, "0");
  const slug = label.replace(/[^\w.]+/g, "-").replace(/^-|-$/g, "");
  return `${runName(run)}_set${set}_${slug}_${rpm}rpm.csv`;
}
/** What a field holds among `values`: its `instead` when that is what they make, or its value. */
function valueLabel(field: EscField, values: EscValues): string {
  const writes = Object.entries(field.instead?.writes ?? {});
  const instead = writes.length > 0 && writes.every(([name, raw]) => values[name] === raw);
  return instead ? field.instead!.label : shown(field, values[field.name]);
}

const escLabel = (grid: EscGrid, values: EscValues) =>
  grid.fields.map(({ field }) => `${field.label} ${valueLabel(field, values)}`).join(", ");

/** Every field an ESC grid's candidates write: its own, and what any `instead` listed writes. */
export const escNames = (grid: EscGrid): string[] => {
  const names = grid.fields.flatMap(({ field, values }) => [field.name, ...values.flatMap(Object.keys)]);
  return [...new Set(names)];
};

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
 * Every candidate a grid describes: for an ESC grid, every combination of its values, or one at a
 * time on the baseline. TBH candidates keep the baseline's kp, which TBH never reads, and ESC
 * candidates spin up on the baseline's gains. An ESC candidate writes every field the grid
 * does, the baseline's value where it lists none, so none keeps what the candidate before it wrote;
 * an `instead` goes on last, over any value another field listed, as AM32 ignores that one.
 */
export function candidatesFor(grid: TuneConfig["grid"], baseline: Settings): Candidate[] {
  const all: Settings[] = [];
  if (grid.kind === "esc") {
    let combos: { own: EscValues; instead: EscValues }[] = [{ own: {}, instead: {} }];
    const split = (v: EscValues, name: string) =>
      name in v ? { own: v, instead: {} } : { own: {}, instead: v };
    if (grid.oneAtATime) {
      combos = grid.fields.flatMap(({ field, values }) => values.map((v) => split(v, field.name)));
    } else {
      for (const { field, values } of grid.fields) {
        combos = combos.flatMap(({ own, instead }) =>
          values.map((v) => {
            const next = split(v, field.name);
            return { own: { ...own, ...next.own }, instead: { ...instead, ...next.instead } };
          }),
        );
      }
    }
    for (const { own, instead } of combos) {
      all.push({ gains: baseline.gains, esc: { ...baseline.esc, ...own, ...instead } });
    }
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

/** Each ESC's settings as read, `motors` giving the motor each passthrough index drives. */
export const escRecords = (escs: EscSettings[], motors: number[]): EscRecord[] =>
  escs.map(({ esc, layout, block }) => ({
    motor: motors[esc],
    eepromVersion: layout.version,
    firmware: firmwareOf(block),
    raw: Object.fromEntries(layout.fields.map((f) => [f.name, block[f.offset]])),
    shown: Object.fromEntries(layout.fields.map((f) => [f.name, shown(f, block[f.offset])])),
  }));

/**
 * The value every ESC holds for each field an ESC grid writes, which the run puts back. ESCs that
 * differ on one have no single value to put back, so they are refused.
 */
export function escOriginals(escs: EscRecord[], grid: EscGrid): EscValues {
  const values: EscValues = {};
  for (const name of escNames(grid)) {
    const raws = escs.map(({ motor, eepromVersion, raw }) => {
      if (!(name in raw)) {
        throw new Error(`Motor ${motor}'s ESC settings layout ${eepromVersion} lacks ${name}.`);
      }
      return raw[name];
    });
    const field = LAYOUTS[escs[0].eepromVersion].fields.find((f) => f.name === name)!;
    if (new Set(raws).size > 1) {
      throw new Error(
        `The ESCs differ on ${field.label} (${raws.map((r) => shown(field, r)).join(", ")}). ` +
          "Write one value to all of them on the ESCs page, so the run has one to put back.",
      );
    }
    values[name] = raws[0];
  }
  return values;
}

/**
 * The candidate whose settings are the baseline's, when the grid has one. It and the baseline are
 * one row: every baseline set counts as one of its sets too, so it needs fewer of its own.
 */
export function startingId(run: Run): string | null {
  const id = settingsLabel(run.config.grid, run.baseline);
  return run.candidates.some((c) => c.id === id) ? id : null;
}

/**
 * The candidate sets a run takes, and the ESC writes an ESC run does: its plan run through on sets
 * that all score alike. Exact without halving; with it, close, as who survives moves the baseline
 * sets' share. The run's opening read leaves the ESCs on the baseline, a write is a change of
 * settings, and a run that pauses writes twice more: the baseline's back, then the candidate's on
 * Resume.
 */
export function plannedRun(run: Run): { sets: number; writes: number } {
  const same = startingId(run);
  const settingsOf = (id: string) => (id === same ? BASELINE : id);
  const spinup: Spinup = {
    rpm: 0,
    file: "",
    readyMs: 0,
    reachMs: 0,
    overshootPct: 0,
    packMv: 0,
    trace: [],
  };
  let current = startRun(run.config, run.baseline, run.escs, run.blaster, run.rampupTimeoutMs);
  let loaded = BASELINE;
  let writes = 0;
  for (;;) {
    const { search, next } = nextSet(current);
    if (next === null) break;
    if (settingsOf(next) !== loaded) writes++;
    loaded = settingsOf(next);
    const sets = [...current.sets, { id: next, at: 0, spinups: [spinup] }];
    current = { ...current, search, sets };
  }
  const sets = current.sets.filter((s) => s.id !== BASELINE).length;
  return { sets, writes: run.config.grid.kind === "esc" ? writes : 0 };
}

export function startRun(
  config: TuneConfig,
  baseline: Settings,
  escs: EscRecord[] | null,
  blaster: string | null,
  rampupTimeoutMs: number,
): Run {
  const candidates = candidatesFor(config.grid, baseline);
  return {
    version: RUN_VERSION,
    startedAt: Date.now(),
    blaster,
    config,
    baseline,
    escs,
    rampupTimeoutMs,
    candidates,
    search: startSearch(
      candidates.map((c) => c.id),
      config.n,
      config.halving,
    ),
    sets: [],
    status: "running",
    note: null,
    escWrites: 0,
    restoreEscs: false,
    applied: false,
  };
}

/**
 * What a run times a spin-up by: a gains run, fire-ready, as settling is what gains decide; an ESC
 * run, reaching ESC_REACH of target, as the ESCs decide the climb and Trifolium's control the rest.
 */
export const timeOf =
  (grid: TuneConfig["grid"]) =>
  (s: Spinup): number | null =>
    grid.kind === "esc" ? s.reachMs : s.readyMs;

/**
 * A set's score, its spin-ups timed by `time`. One that took no time, or longer than the rampup
 * timeout, counts as timed out, at the timeout.
 */
export function scoreOf(
  set: SetRecord,
  rampupTimeoutMs: number,
  time: (s: Spinup) => number | null,
): SetScore {
  const times = set.spinups.map(time);
  const timedOut = (t: number | null) => t === null || t > rampupTimeoutMs;
  return {
    timedOut: times.some(timedOut),
    ms: times.reduce((sum: number, t) => sum + (timedOut(t) ? rampupTimeoutMs : t!), 0),
    overshootPct: Math.max(...set.spinups.map((s) => s.overshootPct)),
  };
}

/** Whether a set counts for `id`: its own, and for the starting candidate the baseline's too. */
export const countsFor = (set: SetRecord, id: string, same: string | null) =>
  set.id === id || (id === same && set.id === BASELINE);

/** Each candidate's set scores and the baseline's, in the order they ran - see countsFor(). */
export function scoresOf(run: Run): Record<string, SetScore[]> {
  const same = startingId(run);
  const time = timeOf(run.config.grid);
  const scores: Record<string, SetScore[]> = {};
  for (const set of run.sets) {
    const score = scoreOf(set, run.rampupTimeoutMs, time);
    (scores[set.id] ??= []).push(score);
    if (same && set.id === BASELINE) (scores[same] ??= []).push(score);
  }
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
  const { search, next } = plan(run.search, scoresOf(run), overshootLimit(run.config.grid), stay);

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
 * Reads a spin-up off its capture: the firmware's own fire-ready time, when every motor had reached
 * ESC_REACH of `rpm`, and how far the worst motor went past `rpm` once it first got there, as % of
 * `rpm`. `traceMs` is how much of each motor's RPM and throttle to keep for the chart. A capture
 * that did not start from rest at `rpm` is some other rev's - the trigger, the Rev switch, a hold
 * that lapsed and came back - and is refused.
 */
export function measure(
  capture: Capture,
  rpm: number,
  file: string,
  traceMs: number,
): Spinup {
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
  const reached = log.motors.map((m) => m.rpm.findIndex((v) => v >= rpm * ESC_REACH));
  const kept = (values: number[]) =>
    values.slice(0, traceMs).filter((_, i) => i % TRACE_STEP === 0);
  return {
    rpm,
    file,
    readyMs: capture.report.readyMs,
    reachMs: reached.includes(-1) ? null : Math.max(...reached) * MS_PER_SAMPLE,
    overshootPct,
    packMv: log.voltage[0],
    trace: log.motors.map((m) => ({
      rpm: kept(m.rpm),
      full: stretches(kept(m.throttle).map((t) => t >= capture.report.maxThrottle)),
    })),
  };
}

/** Where `on` holds, as [from, to) runs. */
function stretches(on: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  on.forEach((v, i) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  });
  return out;
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
