import React from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { shown } from "../esc/layouts";
import type { EscRow } from "../esc/rows";
import type { EscSettings } from "../esc/session";
import {
  BASELINE,
  BASELINE_BLOCK,
  baselineOf,
  DESYNC_BELOW,
  DESYNC_MS,
  DESYNC_REACHED,
  ESC_REACH,
  countsFor,
  gainsLabel,
  overshootLimit,
  plannedRun,
  rankingOf,
  startingId,
  scoreOf,
  scoresOf,
  settingsLabel,
  startRun,
  timeOf,
  TRACE_STEP,
  type Candidate,
  type Gains,
  type GainsGrid,
  type Run,
  type MotorTrace,
  type SetRecord,
  type Spinup,
  type TuneConfig,
} from "../tune/run";
import { runSettings, type TuneRunner } from "../tune/runner";
import { standing, type SetScore, type Standing } from "../tune/search";
import { configOf, searchableRows, takes, type Form, type TuneDraft } from "../tune/draft";
import { Fieldset } from "./Section";
import { RpmChart, type Series } from "./RpmChart";

// The spin-up search: runs spin-ups on the blaster by itself and finds the flywheel gains, or the
// AM32 ESC settings, with the shortest dependable spin-up. Each candidate is tried at every target
// RPM, the same number of times each (tune/search.ts), and the runner (tune/runner.ts) drives the
// blaster. A run lives in this browser until discarded, so a reload or a dropped link pauses it
// rather than losing it.

const COLOURS = [
  "#4f9dff",
  "#ff9f40",
  "#4ad991",
  "#e57bd8",
  "#f2d14b",
  "#5fd3e6",
  "#ff6b6b",
  "#a78bfa",
];

/** Rough wall-clock cost of one spin-up: the hold, the capture, the spin-down and the rest. */
const SPINUP_S = 5;
/** And of one ESC write: into passthrough, the write, and back to a blaster that answers. */
const ESC_WRITE_S = 15;

const cellSx = { py: 0.25, px: 1 };

const msText = (ms: number) =>
  ms === Infinity ? "timeout" : Number.isNaN(ms) ? "—" : `${Math.round(ms)} ms`;

/** A row's figures. Overshoot shows for a gains run only: Trifolium's own control makes it. */
function StandingCells({
  s,
  scores,
  overshoot,
}: {
  s: Standing;
  scores: SetScore[];
  overshoot: boolean;
}) {
  const mean = scores.reduce((sum, x) => sum + x.ms, 0) / scores.length;
  const slowest = scores.length
    ? Math.max(...scores.map((x) => (x.timedOut ? Infinity : x.ms)))
    : NaN;
  return (
    <>
      <TableCell sx={cellSx}>{s.timeouts}</TableCell>
      <TableCell sx={cellSx}>{msText(mean)}</TableCell>
      <TableCell sx={cellSx}>{msText(s.ms)}</TableCell>
      <TableCell sx={cellSx}>{msText(slowest)}</TableCell>
      {overshoot && (
        <TableCell sx={cellSx}>
          {Number.isNaN(s.overshootPct) ? "—" : `${s.overshootPct.toFixed(1)}%`}
        </TableCell>
      )}
      <TableCell sx={cellSx}>{s.sets}</TableCell>
    </>
  );
}

/** The baseline's colour, and the starting candidate's, which is one row with it. */
const BASELINE_COLOUR = "#9aa0a6";

/**
 * A row's chart and checkbox colour, from its candidate's place in the grid, so it keeps it however
 * rows are checked.
 */
const colourOf = (candidates: Candidate[], same: string | null, id: string) =>
  id === BASELINE || id === same
    ? BASELINE_COLOUR
    : COLOURS[candidates.findIndex((c) => c.id === id) % COLOURS.length];

export function Results({
  run,
  checked,
  onCheck,
}: {
  run: Run;
  /** The rows whose spin-ups are charted: candidate ids and BASELINE, in the order checked. */
  checked: string[];
  onCheck: (checked: string[]) => void;
}) {
  const limit = overshootLimit(run.config.grid);
  const scores = scoresOf(run);
  const rows = rankingOf(run);
  const same = startingId(run);
  const nameOf = (id: string) => run.candidates.find((c) => c.id === id)!.name;
  const overshoot = run.config.grid.kind === "gains";
  // What the time columns time: fire-ready, or reaching ESC_REACH of target in an ESC run.
  const to = overshoot ? "" : ` to ${ESC_REACH * 100}%`;
  const box = (id: string, label: string) => {
    const on = checked.includes(id);
    const colour = on ? colourOf(run.candidates, same, id) : undefined;
    return (
      <TableCell padding="checkbox">
        <Checkbox
          size="small"
          checked={on}
          onChange={() => onCheck(on ? checked.filter((c) => c !== id) : [...checked, id])}
          sx={{ py: 0, color: colour, "&.Mui-checked": { color: colour } }}
          slotProps={{ input: { "aria-label": `Chart ${label}` } }}
        />
      </TableCell>
    );
  };
  return (
    <Table size="small" sx={{ width: "auto" }}>
      <TableHead>
        <TableRow>
          {[
            "Chart",
            "Candidate",
            "Timeouts",
            ...["Mean", "2nd slowest", "Slowest"].map((h) => h + to),
            ...(overshoot ? ["2nd worst overshoot"] : []),
            "Sets",
          ].map((h) => (
            <TableCell key={h} sx={{ ...cellSx, fontWeight: 600 }}>
              {h}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(({ id, standing: s }) => (
          <TableRow key={id}>
            {box(id, nameOf(id))}
            <TableCell sx={cellSx}>
              {nameOf(id)}
              <Flags text={flagsOf(id === same, s, limit)} />
            </TableCell>
            <StandingCells s={s} scores={scores[id] ?? []} overshoot={overshoot} />
          </TableRow>
        ))}
        {scores[BASELINE] && same === null && (
          <TableRow>
            {box(BASELINE, "the baseline")}
            <TableCell sx={{ ...cellSx, fontStyle: "italic" }}>
              Baseline: {settingsLabel(run.config.grid, run.baseline)}
              <Flags text={flagsOf(false, standing(scores[BASELINE], limit), limit)} />
            </TableCell>
            <StandingCells
              s={standing(scores[BASELINE], limit)}
              scores={scores[BASELINE]}
              overshoot={overshoot}
            />
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** Which of each checked row's spin-ups the chart draws: all, or the one at a rank. */
type Drawn = "all" | "median" | "secondSlowest" | "slowest";

const DRAWN: { value: Drawn; label: string }[] = [
  { value: "all", label: "All spin-ups" },
  { value: "median", label: "Median" },
  { value: "secondSlowest", label: "2nd slowest" },
  { value: "slowest", label: "Slowest" },
];

const Flags = ({ text }: { text: string | null }) =>
  text && (
    <Typography component="span" sx={{ fontSize: "inherit", fontStyle: "italic" }}>
      {" "}
      ({text})
    </Typography>
  );

/** What sets a candidate's row apart, or null: the starting settings, or what rules it out. */
function flagsOf(starting: boolean, s: Standing, limit: number | null): string | null {
  const flags = [
    starting && "starting settings",
    s.desync && `lost sync: motor ${s.desync.motor} fell to ${s.desync.minRpm} RPM`,
    s.overshoots && `overshoots past ${limit}%`,
  ].filter((f) => f);
  return flags.length > 0 ? flags.join("; ") : null;
}

/**
 * The spin-up at `drawn`'s rank by `time`, a timeout or a loss of sync slowest, as the score has
 * them: the lower median of an even count, so always one that ran.
 */
export function atRank(
  spinups: Spinup[],
  drawn: Exclude<Drawn, "all">,
  time: (s: Spinup) => number | null,
): Spinup {
  const key = (s: Spinup) => (s.desync ? Infinity : (time(s) ?? Infinity));
  const sorted = [...spinups].sort((a, b) => key(a) - key(b));
  const last = sorted.length - 1;
  const index = { median: last >> 1, secondSlowest: Math.max(0, last - 1), slowest: last }[drawn];
  return sorted[index];
}

/**
 * A motor's RPM as a solid line where it ran at full throttle and a dashed one where the controller
 * backed off, the two meeting where it changes.
 */
function byThrottle({ rpm, full }: MotorTrace): { solid: number[]; dashed: number[] } {
  const isFull = rpm.map((_, i) => full.some(([from, to]) => i >= from && i < to));
  return {
    solid: rpm.map((v, i) => (isFull[i] ? v : NaN)),
    // A full sample next to one that is not ends the dashed line there too, so the two join.
    dashed: rpm.map((v, i) =>
      isFull[i] && isFull[i - 1] !== false && isFull[i + 1] !== false ? NaN : v,
    ),
  };
}

/**
 * Each checked row's spin-ups, a chart per target RPM: each motor's RPM, in the row's colour, all
 * of them overlaid or the one at a rank, ranked within each RPM by `grid`'s timeOf(). A line is
 * solid at full throttle and dashed where the controller backed off. The starting candidate's row
 * has the baseline's spin-ups too, as `same` says. Memoised on the sets, which change only as a set
 * ends, so the chart redraws once a set and never while a rev is held.
 */
export const SpinupTraces = React.memo(function SpinupTraces({
  sets,
  rpms,
  candidates,
  checked,
  same,
  grid,
}: {
  sets: SetRecord[];
  rpms: number[];
  /** In the grid's order, which gives each its colour. */
  candidates: Candidate[];
  checked: string[];
  same: string | null;
  grid: TuneConfig["grid"];
}) {
  const time = timeOf(grid);
  const [drawn, setDrawn] = React.useState<Drawn>("all");
  if (checked.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        Check rows to chart their spin-ups.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      <TextField
        select
        size="small"
        label="Spin-ups to chart"
        value={drawn}
        onChange={(e) => setDrawn(e.target.value as Drawn)}
        sx={{ width: 200 }}
      >
        {DRAWN.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}
          </MenuItem>
        ))}
      </TextField>
      {rpms.map((rpm, k) => {
        const series: Series[] = checked.map((id) => {
          const name = id === BASELINE ? "Baseline" : candidates.find((c) => c.id === id)!.name;
          const colour = colourOf(candidates, same, id);
          // A set stops at the spin-up where a motor lost sync.
          const spinups = sets
            .filter((s) => countsFor(s, id, same))
            .flatMap((s) => s.spinups[k] ?? []);
          const lines = (traces: MotorTrace[]) => {
            const parts = traces.map(byThrottle);
            return { lines: parts.map((p) => p.solid), dashed: parts.map((p) => p.dashed) };
          };
          if (drawn === "all" || spinups.length === 0) {
            return { name, colour, ...lines(spinups.flatMap((s) => s.trace)) };
          }
          const one = atRank(spinups, drawn, time);
          const ms = time(one);
          const label = `${name} (${one.desync ? "lost sync" : ms === null ? "timeout" : `${ms} ms`})`;
          return { name: label, colour, ...lines(one.trace) };
        });
        return (
          <Box key={rpm}>
            <Typography variant="caption" color="text.secondary">
              {DRAWN.find((o) => o.value === drawn)!.label} at {rpm} RPM, each motor's line
            </Typography>
            <RpmChart series={series} height={240} xLabel="ms" sampleMs={TRACE_STEP} />
          </Box>
        );
      })}
    </Stack>
  );
});

/**
 * The baseline's spin-ups at the run's start and, once it has them, its end, and how far its mean
 * moved between: the drift every candidate's sets ran under. Null before the first.
 */
function driftOf(run: Run): string | null {
  const ids = run.sets.map((s) => s.id);
  const firstCandidate = ids.findIndex((id) => id !== BASELINE);
  let lastCandidate = ids.length - 1;
  while (lastCandidate >= 0 && ids[lastCandidate] === BASELINE) lastCandidate--;
  const scored = (sets: SetRecord[]) =>
    sets.map((s) => scoreOf(s, run));
  const shown = (scores: SetScore[]) =>
    scores.map((s) => (s.timedOut ? "timeout" : `${s.ms}`)).join(", ") + " ms";
  const first = scored(run.sets.slice(0, firstCandidate < 0 ? ids.length : firstCandidate));
  if (first.length === 0) return null;
  const last = lastCandidate < 0 ? [] : scored(run.sets.slice(lastCandidate + 1));
  if (last.length === 0) return `Baseline at the start: ${shown(first)}.`;
  const mean = (scores: SetScore[]) => scores.reduce((sum, s) => sum + s.ms, 0) / scores.length;
  const change = ((mean(last) - mean(first)) / mean(first)) * 100;
  return (
    `Baseline at the start: ${shown(first)}; at the end: ${shown(last)}, its mean ` +
    `${Math.abs(change).toFixed(1)}% ${change > 0 ? "slower" : "faster"}.`
  );
}

/** The ESC settings an ESC run can vary, each with what the ESCs hold now and the values to try. */
function EscGridForm({
  rows,
  esc,
  onEsc,
}: {
  rows: EscRow[];
  esc: Record<string, string>;
  onEsc: (esc: Record<string, string>) => void;
}) {
  return (
    <Table size="small" sx={{ width: "auto" }}>
      <TableHead>
        <TableRow>
          {["Setting", "ESCs now", "Values to try"].map((h) => (
            <TableCell key={h} sx={{ ...cellSx, fontWeight: 600 }}>
              {h}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(({ field, raws, disagree }) => (
          <TableRow key={field.name}>
            <TableCell sx={cellSx}>{field.label}</TableCell>
            <TableCell sx={{ ...cellSx, color: disagree ? "warning.main" : undefined }}>
              {disagree ? "differ" : shown(field, raws[0]!)}
            </TableCell>
            <TableCell sx={cellSx}>
              <TextField
                size="small"
                variant="standard"
                value={esc[field.name] ?? ""}
                placeholder={takes(field)}
                onChange={(e) => onEsc({ ...esc, [field.name]: e.target.value })}
                sx={{ width: 260 }}
                slotProps={{ htmlInput: { "aria-label": `${field.label} values` } }}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Tune({
  runner,
  live,
  device,
  gainMax,
  escs,
  draft,
  onDraft,
  onApply,
}: {
  runner: TuneRunner;
  live: boolean;
  /** The device config, for the baseline gains and the capture settings. */
  device: unknown;
  gainMax: { kp: number; ki: number };
  /** The flywheel ESCs' settings as last read, for the settings an ESC run can vary. */
  escs: EscSettings[] | null;
  draft: TuneDraft;
  onDraft: (draft: TuneDraft) => void;
  /** Writes the winner's gains to the device's stored settings. */
  onApply: (gains: Gains) => void;
}) {
  runner.load();
  const run = React.useSyncExternalStore(runner.subscribe, runner.getRun);
  const activity = React.useSyncExternalStore(runner.subscribe, runner.getActivity);
  /** The runner is driving the blaster, so its buttons would do nothing. */
  const driving = React.useSyncExternalStore(runner.subscribe, runner.running);
  /** Why the last Start did not start. */
  const [failed, setFailed] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState<string[]>([]);
  const { kind, mode, form } = draft;
  const rows = React.useMemo(() => (escs ? searchableRows(escs) : []), [escs]);
  const config = configOf(draft, gainMax, rows);
  const settings = runSettings(device);
  const baseline = baselineOf(device);
  const current = run === null || run === "unreadable" ? null : run;
  // Running a plan through takes a while for a big grid, so each is worked out once.
  const draftKey = JSON.stringify([config, baseline]);
  const draftPlan = React.useMemo(() => {
    if (typeof config === "string" || baseline === null) return null;
    const escNow = (name: string) => rows.find((r) => r.field.name === name)!.raws[0]!;
    const { grid } = config;
    const esc =
      grid.kind === "esc"
        ? Object.fromEntries(grid.fields.map(({ field }) => [field.name, escNow(field.name)]))
        : null;
    const draftRun = startRun(config, { gains: baseline, esc }, null, null, 0);
    return { count: draftRun.candidates.length, ...plannedRun(draftRun) };
  }, [draftKey, rows]);
  const runPlan = React.useMemo(() => current && plannedRun(current), [current?.candidates]);
  const field = (key: keyof Form, label: string, width = 160) => (
    <TextField
      size="small"
      label={label}
      value={form[key]}
      onChange={(e) => onDraft({ ...draft, form: { ...form, [key]: e.target.value } })}
      sx={{ width }}
    />
  );
  const activityLine = activity && (
    <Typography variant="body2" color="text.secondary">
      {activity}
    </Typography>
  );

  if (run === "unreadable") {
    return (
      <Alert
        severity="error"
        action={
          <Button size="small" color="inherit" onClick={() => void runner.discard()}>
            Discard run
          </Button>
        }
      >
        The run saved in this browser came from a different build of the console, and this build
        can't read it.
      </Alert>
    );
  }

  if (!run) {
    const count = draftPlan?.count ?? 0;
    const spinups =
      draftPlan && typeof config !== "string" ? draftPlan.sets * config.rpms.length : 0;
    const writes = draftPlan?.writes ?? 0;
    const minutes = Math.round((spinups * SPINUP_S + writes * ESC_WRITE_S) / 60);
    const problem =
      kind === "esc" && escs === null
        ? "Read the ESCs on the ESCs page first: an ESC run lists their settings."
        : typeof config === "string"
          ? config
          : baseline === null
            ? "No motor is enabled."
            : typeof settings === "string"
              ? settings
              : null;
    const start = () => {
      setFailed(null);
      runner
        .start(config as TuneConfig, baseline!, device)
        .catch((e: Error) => setFailed(e.message));
    };
    return (
      <Stack spacing={1.25}>
        <Fieldset label="Search">
          <Stack spacing={1.25} sx={{ pt: 1 }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={kind}
              onChange={(_, v: TuneDraft["kind"] | null) => v && onDraft({ ...draft, kind: v })}
            >
              <ToggleButton value="gains">Flywheel gains</ToggleButton>
              <ToggleButton value="esc">ESC settings</ToggleButton>
            </ToggleButtonGroup>
            {kind === "gains" ? (
              <>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={mode}
                  onChange={(_, v: GainsGrid["mode"] | null) => v && onDraft({ ...draft, mode: v })}
                >
                  <ToggleButton value="pid">PID</ToggleButton>
                  <ToggleButton value="tbh">TBH</ToggleButton>
                  <ToggleButton value="both">Both</ToggleButton>
                </ToggleButtonGroup>
                <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
                  {mode !== "tbh" && field("kp", "PID kp values")}
                  {mode !== "tbh" && field("ki", "PID ki values")}
                  {mode !== "pid" && field("tbh", "TBH gains")}
                  {field("overshootLimitPct", "Overshoot limit %", 150)}
                </Stack>
              </>
            ) : (
              <>
                {escs && (
                  <EscGridForm
                    rows={rows}
                    esc={draft.esc}
                    onEsc={(esc) => onDraft({ ...draft, esc })}
                  />
                )}
                <Typography variant="caption" color="text.secondary">
                  Values are comma-separated, as the ESCs page shows them. Search a few settings at a
                  time: PWM frequency first, coarsely; then the startup group - startup power,
                  sinusoidal startup with its range and power, Motor Kv (Off disables low-RPM power
                  protection) and ramp rate; then timing advance; then the startup group again.
                </Typography>
              </>
            )}
            {kind === "esc" && (
              <ToggleButtonGroup
                size="small"
                exclusive
                value={draft.oneAtATime}
                onChange={(_, v: boolean | null) =>
                  v !== null && onDraft({ ...draft, oneAtATime: v })
                }
              >
                <ToggleButton value={false}>All combinations</ToggleButton>
                <ToggleButton value={true}>One setting at a time</ToggleButton>
              </ToggleButtonGroup>
            )}
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
              {field("rpms", "Target RPMs")}
              {field("n", "Spin-ups per candidate", 170)}
              {field("cellV", "Pause below V a cell", 150)}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {count} candidates, about {spinups} spin-ups
              {kind === "esc" ? ` and about ${writes} ESC writes` : ""} ({minutes} min), with the
              blaster's own settings
              {baseline && kind === "gains" ? ` (${gainsLabel(baseline)})` : ""}{" "}
              run {BASELINE_BLOCK} times first and last to show drift; a candidate with those
              settings counts those spin-ups as its own. Each spin-up holds Rev from a standstill.
              Every candidate gets N spin-ups, and ranks on fewest rampup timeouts, then the
              second-slowest of its N spin-ups
              (the 95th percentile at the default N = 20), each summed over the target RPMs
              {kind === "gains"
                ? ", and one whose second-worst overshoot passes the limit cannot win. "
                : ". "}
              A motor that reaches {DESYNC_REACHED * 100}% of target, then stays below{" "}
              {DESYNC_BELOW * 100}% for {DESYNC_MS} ms before the rev ends, has lost sync: its
              candidate gets no more spin-ups and cannot win, and on the blaster's own settings
              the run pauses.{" "}
              {kind === "esc"
                ? `An ESC run times a spin-up to the slower wheel reaching ${ESC_REACH * 100}% of ` +
                  "target, the climb the ESCs decide; one that does not within the rampup timeout " +
                  "counts as a timeout. "
                : "A gains run times a spin-up to fire-ready. "}
              Mean counts a timed-out spin-up at the rampup timeout, so it is a lower bound when
              Timeouts is not 0.{" "}
              {kind === "esc"
                ? "Each candidate is written to every flywheel ESC once, then runs its spin-ups at " +
                  "the blaster's own gains. A write restarts the blaster and " +
                  "is one erase of each ESC's settings flash, which lasts about 10,000. The ESCs " +
                  "get their own settings back when the run stops, unless you apply the winner."
                : "Nothing is stored until you apply the winner."}
            </Typography>
            {problem && live && (
              <Alert severity="info" sx={{ py: 0 }}>
                {problem}
              </Alert>
            )}
            {failed && (
              <Alert severity="error" sx={{ py: 0 }}>
                {failed}
              </Alert>
            )}
            {activityLine}
            <Box>
              <Button
                variant="contained"
                size="small"
                disabled={!live || problem !== null || driving}
                onClick={start}
              >
                Start
              </Button>
            </Box>
          </Stack>
        </Fieldset>
      </Stack>
    );
  }

  const candidateSets = run.sets.filter((s) => s.id !== BASELINE).length;
  const lastSet = run.sets[run.sets.length - 1];
  const packV = lastSet && Math.min(...lastSet.spinups.map((s) => s.packMv)) / 1000;
  const drift = driftOf(run);
  const best = run.status === "done" ? rankingOf(run)[0] : null;
  // Nothing to apply when even the best overshoots past the limit.
  const winner = best?.standing.qualified ? run.candidates.find((c) => c.id === best.id)! : null;
  const escRun = run.config.grid.kind === "esc";
  return (
    <Stack spacing={1.25}>
      <Fieldset label="Search">
        <Stack spacing={1} sx={{ pt: 1 }}>
          <Typography variant="body2">
            {{ done: "Done.", running: "Running.", paused: "Paused." }[run.status]}{" "}
            {candidateSets} of about {runPlan!.sets} candidate sets
            {lastSet ? `, pack ${packV.toFixed(2)} V` : ""}.
            {escRun && ` ${run.escWrites} of about ${runPlan!.writes} planned ESC writes.`}
          </Typography>
          {activityLine}
          {run.note && (
            <Alert severity="info" sx={{ py: 0 }}>
              {run.note}
            </Alert>
          )}
          {run.restoreEscs && run.status !== "running" && activity === null && (
            <Alert severity="warning" sx={{ py: 0 }}>
              The ESCs may still hold a candidate's settings. Their own settings go back when this
              run's blaster next connects, or on Discard.
            </Alert>
          )}
          {drift && (
            <Typography variant="caption" color="text.secondary">
              {drift}
            </Typography>
          )}
          <Stack direction="row" spacing={1}>
            {run.status === "running" && (
              <Button size="small" variant="outlined" onClick={() => runner.pause()}>
                Pause
              </Button>
            )}
            {run.status === "paused" && (
              <Button
                size="small"
                variant="contained"
                disabled={!live || driving}
                onClick={() => runner.resume(device)}
              >
                Resume
              </Button>
            )}
            {winner && (
              <Button
                size="small"
                variant="contained"
                disabled={!live || driving || run.applied}
                onClick={() =>
                  winner.esc ? void runner.applyEsc(winner) : runner.applyGains(winner, onApply)
                }
              >
                {run.applied ? "Applied" : "Apply"} {winner.name}
              </Button>
            )}
            {run.status !== "running" && (
              <Button
                size="small"
                variant="outlined"
                disabled={driving || (run.restoreEscs && !live)}
                onClick={() => void runner.discard()}
              >
                Discard run
              </Button>
            )}
          </Stack>
        </Stack>
      </Fieldset>
      <Fieldset label="Results">
        <Stack spacing={1} sx={{ pt: 1 }}>
          <Results run={run} checked={checked} onCheck={setChecked} />
          <SpinupTraces
            sets={run.sets}
            rpms={run.config.rpms}
            candidates={run.candidates}
            checked={checked}
            same={startingId(run)}
            grid={run.config.grid}
          />
        </Stack>
      </Fieldset>
    </Stack>
  );
}
