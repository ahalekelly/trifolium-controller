import React from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
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
import { downloadJson } from "../config/bundle";
import { accepted, parseShown, shown } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import {
  BASELINE,
  baselineOf,
  candidatesFor,
  DEFAULT_CONFIG,
  DEFAULT_GAINS,
  gainsLabel,
  plannedEscWrites,
  scoreOf,
  scoresOf,
  settingsLabel,
  type EscGrid,
  type Gains,
  type GainsGrid,
  type Run,
  type TuneConfig,
} from "../tune/run";
import { runSettings, type TuneRunner } from "../tune/runner";
import { planned, ranking, standing, type Standing } from "../tune/search";
import { escRows, type EscRow } from "./EscSettings";
import { Fieldset } from "./Section";
import { RpmChart, type Series } from "./RpmChart";

// The spin-up search: runs spin-ups on the blaster by itself and finds the flywheel gains, or the
// AM32 ESC settings, with the shortest dependable spin-up. Each candidate is tried at every target
// RPM; successive halving spends most of the spin-ups on the candidates still in contention
// (tune/search.ts), and the runner (tune/runner.ts) drives the blaster. A run lives in this browser
// until discarded, so a reload or a dropped link pauses it rather than losing it.

const COLOURS = ["#4f9dff", "#ff9f40", "#4ad991", "#e57bd8"];

/** Rough wall-clock cost of one spin-up: the hold, the capture, the spin-down and the rest. */
const SPINUP_S = 5;
/** And of one ESC write: into passthrough, the write, and back to a blaster that answers. */
const ESC_WRITE_S = 15;

/** The form's text for a config, and back. */
type Form = Record<"kp" | "ki" | "tbh" | "rpms" | "n" | "overshootLimitPct" | "cellV", string>;

/** The search form as typed, kept by App so it outlasts a visit to another tab. */
export interface TuneDraft {
  kind: TuneConfig["grid"]["kind"];
  mode: GainsGrid["mode"];
  form: Form;
  /** Each ESC setting's values to try, as typed, by AM32 field name. */
  esc: Record<string, string>;
}

export const DEFAULT_DRAFT: TuneDraft = {
  kind: "gains",
  mode: DEFAULT_GAINS.mode,
  form: {
    kp: DEFAULT_GAINS.kp.join(", "),
    ki: DEFAULT_GAINS.ki.join(", "),
    tbh: DEFAULT_GAINS.tbh.join(", "),
    rpms: DEFAULT_CONFIG.rpms.join(", "),
    n: String(DEFAULT_CONFIG.n),
    overshootLimitPct: String(DEFAULT_CONFIG.overshootLimitPct),
    cellV: String(DEFAULT_CONFIG.pauseCellMv / 1000),
  },
  esc: {},
};

/** The settings an ESC run can vary: the searchable ones every ESC has. */
const searchableRows = (escs: EscSettings[]): EscRow[] =>
  escRows(escs).filter((r) => r.field.searchable && r.raws.every((raw) => raw !== null));

/** Comma- or space-separated numbers, or null if any is not one. */
const listOf = (text: string): number[] | null => {
  const items = text.split(/[\s,]+/).filter(Boolean).map(Number);
  return items.length && items.every(Number.isFinite) ? items : null;
};

/** The grid the form describes, or what is wrong with it. */
function gridOf(
  { kind, mode, form, esc }: TuneDraft,
  gainMax: { kp: number; ki: number },
  rows: EscRow[],
): TuneConfig["grid"] | string {
  if (kind === "esc") {
    const fields: EscGrid["fields"] = [];
    for (const { field } of rows) {
      const typed = (esc[field.name] ?? "").split(",").filter((t) => t.trim());
      if (typed.length === 0) continue;
      const values = typed.map((t) => parseShown(field, t));
      if (values.some((v) => v === null)) return `${field.label} takes ${accepted(field)}.`;
      fields.push({ field, values: [...new Set(values as number[])] });
    }
    return fields.length > 0 ? { kind, fields } : "List values to try for at least one setting.";
  }
  const [kp, ki, tbh] = [form.kp, form.ki, form.tbh].map(listOf);
  const within = (values: number[] | null, max: number) =>
    values !== null && values.every((v) => v >= 0 && v <= max);
  if (mode !== "tbh" && !(within(kp, gainMax.kp) && within(ki, gainMax.ki))) {
    return `PID gains are numbers from 0: kp up to ${gainMax.kp}, ki up to ${gainMax.ki}.`;
  }
  if (mode !== "pid" && !within(tbh, gainMax.ki)) {
    return `TBH gains are numbers from 0 to ${gainMax.ki}.`;
  }
  return { kind, mode, kp: kp ?? [], ki: ki ?? [], tbh: tbh ?? [] };
}

/** The config the form describes, or what is wrong with it. */
function configOf(
  draft: TuneDraft,
  gainMax: { kp: number; ki: number },
  rows: EscRow[],
): TuneConfig | string {
  const grid = gridOf(draft, gainMax, rows);
  if (typeof grid === "string") return grid;
  const { form } = draft;
  const rpms = listOf(form.rpms);
  const [n, overshootLimitPct, cellV] = [form.n, form.overshootLimitPct, form.cellV].map(Number);
  if (!rpms || !rpms.every((r) => Number.isInteger(r) && r > 0)) {
    return "Target RPMs are whole numbers.";
  }
  if (!Number.isInteger(n) || n < 2) return "Spin-ups per finalist is a whole number, at least 2.";
  if (!(overshootLimitPct >= 0)) return "The overshoot limit is a percentage.";
  if (!(cellV > 0)) return "The cell voltage to pause at is in volts.";
  return { grid, rpms, n, overshootLimitPct, pauseCellMv: Math.round(cellV * 1000) };
}

/** tune-<when it started, to the minute>.json */
const exportName = (run: Run) => {
  const started = new Date(run.sets[0]?.at ?? Date.now());
  return `tune-${started.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
};

const cellSx = { py: 0.25, px: 1 };

function StandingCells({ s }: { s: Standing }) {
  return (
    <>
      <TableCell sx={cellSx}>{s.timeouts}</TableCell>
      <TableCell sx={cellSx}>
        {s.ms === Infinity ? "timeout" : Number.isNaN(s.ms) ? "—" : `${Math.round(s.ms)} ms`}
      </TableCell>
      <TableCell sx={cellSx}>
        {Number.isNaN(s.overshootPct) ? "—" : `${s.overshootPct.toFixed(1)}%`}
      </TableCell>
      <TableCell sx={cellSx}>{s.sets}</TableCell>
    </>
  );
}

function Results({ run }: { run: Run }) {
  const limit = run.config.overshootLimitPct;
  const scores = scoresOf(run);
  const rows = ranking(run.search, scores, limit);
  const done = run.status === "done";
  return (
    <Table size="small" sx={{ width: "auto" }}>
      <TableHead>
        <TableRow>
          {["Candidate", "", "Timeouts", "p95 spin-up", "p95 overshoot", "Sets"].map((h) => (
            <TableCell key={h} sx={{ ...cellSx, fontWeight: 600 }}>
              {h}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(({ id, standing: s, droppedIn }, i) => (
          <TableRow key={id}>
            <TableCell sx={cellSx}>{id}</TableCell>
            <TableCell sx={{ ...cellSx, color: "text.secondary" }}>
              {droppedIn !== null
                ? `dropped in round ${droppedIn + 1}`
                : !s.qualified && s.sets > 0
                  ? `overshoots past ${limit}%`
                  : done && i === 0
                    ? "best"
                    : "finalist"}
            </TableCell>
            <StandingCells s={s} />
          </TableRow>
        ))}
        {scores[BASELINE] && (
          <TableRow>
            <TableCell sx={{ ...cellSx, fontStyle: "italic" }}>
              Baseline: {settingsLabel(run.config.grid, run.baseline)}
            </TableCell>
            <TableCell sx={cellSx} />
            <StandingCells s={standing(scores[BASELINE], limit)} />
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** Each finalist's latest spin-up at each target RPM, the slowest motor's line. */
function FinalistTraces({ run }: { run: Run }) {
  return (
    <Stack spacing={1}>
      {run.config.rpms.map((rpm, k) => {
        const series: Series[] = run.search.alive
          .filter((id) => run.traces[id])
          .map((id, i) => ({
            name: id,
            colour: COLOURS[i % COLOURS.length],
            values: run.traces[id][k],
          }));
        return (
          <Box key={rpm}>
            <Typography variant="caption" color="text.secondary">
              Finalists at {rpm} RPM, each one's latest spin-up
            </Typography>
            <RpmChart series={series} height={200} />
          </Box>
        );
      })}
    </Stack>
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
                placeholder={accepted(field)}
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
  const { kind, mode, form } = draft;
  const rows = React.useMemo(() => (escs ? searchableRows(escs) : []), [escs]);
  const config = configOf(draft, gainMax, rows);
  const settings = runSettings(device);
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
    const baseline = baselineOf(device);
    const ready = typeof config !== "string" && baseline !== null;
    const count = ready ? candidatesFor(config.grid, { gains: baseline, esc: null }).length : 0;
    const sets = ready ? planned(count, config.n).sets : 0;
    const spinups = ready ? sets * config.rpms.length : 0;
    const writes = ready && kind === "esc" ? plannedEscWrites(count, config.n) : 0;
    const minutes = Math.round((spinups * SPINUP_S + writes * ESC_WRITE_S) / 60);
    const problem =
      kind === "esc" && escs === null
        ? "Read the ESCs on the ESCs tab first: an ESC run lists their settings."
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
                  Values are comma-separated, as the ESCs tab shows them. Search a few settings at a
                  time: PWM frequency first, coarsely; then the startup group - startup power,
                  sinusoidal startup with its range and power, Motor Kv (Off disables low-RPM power
                  protection) and ramp rate; then timing advance; then the startup group again.
                </Typography>
              </>
            )}
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
              {field("rpms", "Target RPMs")}
              {field("n", "Spin-ups per finalist", 150)}
              {field("overshootLimitPct", "Overshoot limit %", 150)}
              {field("cellV", "Pause below V a cell", 150)}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {count} candidates, about {spinups} spin-ups
              {kind === "esc" ? ` and at most ${writes} ESC writes` : ""} ({minutes} min), with the
              blaster's own settings
              {baseline && kind === "gains" ? ` (${gainsLabel(baseline)})` : ""}{" "}
              rerun between every few to show drift. Each spin-up holds Rev from a standstill.
              Halving drops the slower half after a few spin-ups each; the finalists rank on fewest
              rampup timeouts, then the 95th percentile spin-up summed over the target RPMs, and one
              whose 95th percentile overshoot passes the limit cannot win.{" "}
              {kind === "esc"
                ? "Each candidate is written to every flywheel ESC once a round, then runs that " +
                  "round's spin-ups at the blaster's own gains. A write restarts the blaster and " +
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
  const baselineMs = run.sets
    .filter((s) => s.id === BASELINE)
    .map((s) => scoreOf(s))
    .map((s) => (s.timedOut ? "timeout" : `${s.ms}`));
  const best =
    run.status === "done"
      ? ranking(run.search, scoresOf(run), run.config.overshootLimitPct)[0]
      : null;
  // Nothing to apply when even the best overshoots past the limit.
  const winner = best?.standing.qualified ? run.candidates.find((c) => c.id === best.id)! : null;
  const escRun = run.config.grid.kind === "esc";
  return (
    <Stack spacing={1.25}>
      <Fieldset label="Search">
        <Stack spacing={1} sx={{ pt: 1 }}>
          <Typography variant="body2">
            {run.status === "done"
              ? "Done."
              : run.status === "running"
                ? `Running round ${run.search.round + 1} of ${run.search.rounds.length}.`
                : "Paused."}{" "}
            {candidateSets} of about {planned(run.candidates.length, run.config.n).sets} candidate
            sets{lastSet ? `, pack ${packV.toFixed(2)} V` : ""}.
            {escRun &&
              ` ${run.escWrites} of ${plannedEscWrites(run.candidates.length, run.config.n)} ` +
                "planned ESC writes."}
          </Typography>
          {activityLine}
          {run.note && (
            <Alert severity="info" sx={{ py: 0 }}>
              {run.note}
            </Alert>
          )}
          {run.restoreEscs && run.status !== "running" && activity === null && (
            <Alert severity="warning" sx={{ py: 0 }}>
              The ESCs may still hold a candidate's settings. Their own settings go back when the
              blaster next connects, or on Discard.
            </Alert>
          )}
          {baselineMs.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              Baseline spin-ups, first to latest: {baselineMs.join(", ")} ms
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
                disabled={!live || driving}
                onClick={() => (winner.esc ? void runner.applyEsc(winner) : onApply(winner.gains))}
              >
                Apply {winner.id}
              </Button>
            )}
            <Button
              size="small"
              variant="outlined"
              onClick={() => downloadJson(exportName(run), run)}
            >
              Export JSON
            </Button>
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
          <Results run={run} />
          {run.status === "done" && <FinalistTraces run={run} />}
        </Stack>
      </Fieldset>
    </Stack>
  );
}
