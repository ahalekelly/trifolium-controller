// The Tune tab without the browser: runs a spin-up search from the command line, for an agent at
// the bench. See tools/console/README.md for the commands and the run definition.
//
// It drives the same runner the Tune tab does (tune/runner.ts) over the same transport, through a
// Node port (nodeSerial.ts). A run directory holds the stored run, each capture's CSV and, once the
// run finishes or is discarded, its JSON - the files the tab downloads.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { escTargets, readEscSettings, writeEscSettings } from "../esc/session";
import { wholeRows } from "../rpm/parse";
import type { Schema } from "../schema/types";
import {
  configFrom,
  SerialTransport,
  TIMEOUT_SCHEMA_MS,
  type SerialApi,
} from "../serial/transport";
import { configOf, gainMaxOf, searchableRows } from "../tune/draft";
import {
  baselineOf,
  plannedRun,
  rankingOf,
  runName,
  timeOf,
  type Run,
  type RunStore,
} from "../tune/run";
import { TuneRunner } from "../tune/runner";
import { draftFrom } from "./definition";
import { tcpSerialApi, usbSerialApi } from "./nodeSerial";

const USAGE = `Usage:
  npm run tune -- start <run dir> <definition.json> [--port socket://host:port]
  npm run tune -- resume <run dir> [--port socket://host:port]
  npm run tune -- discard <run dir> [--port socket://host:port]

Without --port it opens the one Trifolium plugged in over USB.`;

/** Paused: the run is stored, waiting for resume or discard. */
const EXIT_PAUSED = 3;

/** A line of output, led by the time to the millisecond, so a session's steps can be timed. */
const say = (text: string, at = Date.now()) => {
  const d = new Date(at);
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0"));
  process.stdout.write(`${time.join(":")}.${String(d.getMilliseconds()).padStart(3, "0")} ${text}\n`);
};

/** The stored run, one file in the run directory, as the browser keeps it in localStorage. */
function fileStore(file: string): RunStore {
  return {
    getItem: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    setItem: (_, value) => writeFileSync(file, value),
    removeItem: () => rmSync(file, { force: true }),
  };
}

/** One line per finished set, and a line whenever the run's activity, status or note changes. */
function follow(runner: TuneRunner) {
  let sets = -1;
  let activity: string | null = null;
  let status: string | null = null;
  let note: string | null = null;
  return () => {
    const run = runner.getRun();
    if (activity !== runner.getActivity()) {
      activity = runner.getActivity();
      if (activity) say(activity);
    }
    if (run === null || run === "unreadable") return;
    if (sets >= 0 && run.sets.length > sets) {
      const set = run.sets[run.sets.length - 1];
      const name =
        set.id === "baseline" ? "baseline" : run.candidates.find((c) => c.id === set.id)!.name;
      const time = timeOf(run.config.grid);
      const times = set.spinups.map((s, i) => {
        const ms = time(s);
        return `${run.config.rpms[i]} RPM ${ms === null ? "timeout" : `${ms} ms`}`;
      });
      const done = run.sets.filter((s) => s.id !== "baseline").length;
      say(`set ${run.sets.length} (${done} of about ${plannedRun(run).sets} candidate sets): ${name}: ${times.join(", ")}`);
    }
    sets = run.sets.length;
    if (status !== run.status) {
      status = run.status;
      say(`status: ${run.status}`);
    }
    if (note !== run.note) {
      note = run.note;
      if (note) say(`note: ${note}`);
    }
  };
}

/** Until the runner stops driving the blaster. */
const idle = (runner: TuneRunner) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (runner.running()) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = runner.subscribe(check);
    check();
  });

function results(run: Run) {
  say("ranking, best first:");
  rankingOf(run).forEach(({ id, standing }, i) => {
    const name = run.candidates.find((c) => c.id === id)!.name;
    const ms = Number.isFinite(standing.ms) ? `${Math.round(standing.ms)} ms` : "timeout";
    say(`  ${i + 1}. ${name}: 2nd slowest ${ms}, ${standing.timeouts} timeouts, ${standing.sets} sets`);
  });
}

async function main(args: string[]) {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args, allowPositionals: true, options: { port: { type: "string" } } });
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${USAGE}`);
    }
  })();
  const [command, dir, definition, ...extra] = positionals;
  const commands = ["start", "resume", "discard"];
  if (!commands.includes(command) || !dir || (command === "start") !== (definition !== undefined) || extra.length) {
    throw new Error(USAGE);
  }
  // Reads after text commands are traced only until the run starts, which times the replies the
  // setup waits on without a line per capture chunk for hours after.
  let setup = true;
  const trace = (line: string, text: boolean) => {
    if (setup || !text) say(line);
  };
  const api: SerialApi =
    values.port === undefined ? usbSerialApi(trace) : tcpSerialApi(values.port, trace);
  const draft = command === "start" ? draftFrom(JSON.parse(readFileSync(definition, "utf8"))) : null;
  mkdirSync(dir, { recursive: true });
  const store = fileStore(join(dir, "stored-run.json"));
  if (command === "start" && store.getItem("") !== null) {
    throw new Error(`${dir} holds a run already: resume or discard it.`);
  }
  if (command !== "start" && store.getItem("") === null) throw new Error(`${dir} holds no run.`);

  let runner: TuneRunner;
  const transport = new SerialTransport(api, {
    onLog: ({ kind, text, at }) => {
      // The device's lines, cut short: a config dump is one line of kilobytes.
      say(`log: ${kind === "in" && text.length > 100 ? `${text.slice(0, 100)}...` : text}`, at);
    },
    onCapture: (capture) => runner.capture(capture),
  });
  const saved = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  runner = new TuneRunner(
    transport,
    {
      read: () => readEscSettings(transport, escTargets(device)),
      write: (values) => writeEscSettings(transport, escTargets(device), values),
    },
    {
      capture: (csv, name) => void saved(name, `${wholeRows(csv).csv}\n`),
      run: (run, name) => say(`saved ${saved(name, JSON.stringify(run, null, 2))}`),
    },
    store,
  );
  runner.subscribe(follow(runner));

  if (!(await transport.connect()) || !(await transport.waitReady())) {
    throw new Error("No blaster answered.");
  }
  const device = configFrom(await transport.requestWhole<unknown>("DUMP_DEVICE"));
  if (!device) throw new Error("The blaster did not send its settings.");

  // Ctrl-C pauses as the tab's Pause does: after the spin-up under way, with the blaster's own
  // gains and ESC settings back. Before the run is going, it stops the CLI from starting it. A
  // second Ctrl-C leaves at once, the bare TUNE given a second to get out.
  let stopping = false;
  process.once("SIGINT", () => {
    say("Pausing after this spin-up; Ctrl-C again to leave at once.");
    stopping = true;
    runner.pause();
    process.once("SIGINT", () => {
      setTimeout(() => process.exit(130), 1000);
      void runner.abandon().then(() => process.exit(130));
    });
  });

  // A run left mid-way gets its TUNE dropped and any ESC settings it owes put back first.
  await runner.connected();

  if (command === "discard") {
    await runner.discard();
    if (runner.getRun() !== null) throw new Error("The ESCs' own settings could not be put back.");
  } else if (command === "resume") {
    setup = false;
    if (!stopping) runner.resume(device);
    await idle(runner);
  } else {
    const schema = await transport.requestWhole<Schema>("DUMP_SCHEMA", TIMEOUT_SCHEMA_MS);
    if (!schema) throw new Error("The blaster did not send its schema.");
    const baseline = baselineOf(device);
    if (!baseline) throw new Error("No motor is enabled.");
    const escs = draft!.kind === "esc" ? await readEscSettings(transport, escTargets(device)) : [];
    const rows = searchableRows(escs);
    const names = rows.map((r) => r.field.name);
    const unknown = Object.keys(draft!.esc).filter((name) => !names.includes(name));
    if (unknown.length > 0) {
      throw new Error(`No ESC setting to search is named ${unknown.join(", ")}: there are ${names.join(", ")}.`);
    }
    const config = configOf(draft!, gainMaxOf(schema), rows);
    if (typeof config === "string") throw new Error(config);
    if (stopping) throw new Error("Stopped before the run started.");
    await runner.start(config, baseline, device);
    setup = false;
    const run = runner.getRun() as Run;
    const plan = plannedRun(run);
    say(`plan: ${run.candidates.length} candidates, about ${plan.sets} candidate sets` +
      (config.grid.kind === "esc" ? ` and ${plan.writes} ESC writes` : "") + ` (${runName(run)})`);
    await idle(runner);
  }

  const run = runner.getRun();
  await transport.disconnect("Done with the blaster.");
  if (run === null) return 0;
  if (run === "unreadable") throw new Error(`${dir} holds a run another console build saved: discard it.`);
  if (run.status === "done") {
    results(run);
    return 0;
  }
  say(`paused: resume with: npm run tune -- resume ${dir}, or discard it to save its JSON.`);
  return EXIT_PAUSED;
}

// Exits once stdout has taken everything written, which a slow reader of a pipe may not have yet.
const exit = (code: number) => process.stdout.write("", () => process.exit(code));
main(process.argv.slice(2)).then(exit, (e: Error) => {
  process.stderr.write(`error: ${e.message}\n`, () => exit(1));
});
