// The Tune tab without the browser: runs a spin-up search from the command line, for an agent at
// the bench. See tools/console/README.md for the commands and the run definition.
//
// It drives the same runner the Tune tab does (tune/runner.ts) over the same transport, through a
// Node port (nodeSerial.ts). A run directory holds the stored run, each capture's CSV and, once the
// run finishes or is discarded, its JSON - the files the tab downloads.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escRows } from "../esc/rows";
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

const say = (text: string) => process.stdout.write(`${text}\n`);

/** The stored run, one file in the run directory, as the browser keeps it in localStorage. */
function fileStore(file: string): RunStore {
  return {
    getItem: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    setItem: (_, value) => writeFileSync(file, value),
    removeItem: () => rmSync(file, { force: true }),
  };
}

/** One line per finished set, and a line whenever the run's activity or status changes. */
function follow(runner: TuneRunner) {
  let sets = -1;
  let activity: string | null = null;
  let status: string | null = null;
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
      say(`status: ${run.status}${run.note ? ` - ${run.note}` : ""}`);
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
  const portAt = args.indexOf("--port");
  const api: SerialApi = portAt >= 0 ? tcpSerialApi(args[portAt + 1]) : usbSerialApi;
  const [command, dir, definition] = portAt >= 0 ? [...args.slice(0, portAt), ...args.slice(portAt + 2)] : args;
  const wanted = command === "start" ? 3 : 2;
  if (!["start", "resume", "discard"].includes(command) || !dir || (definition === undefined) !== (wanted === 2)) {
    throw new Error(USAGE);
  }
  const draft = command === "start" ? draftFrom(JSON.parse(readFileSync(definition, "utf8"))) : null;
  mkdirSync(dir, { recursive: true });
  const store = fileStore(join(dir, "stored-run.json"));
  if (command === "start" && store.getItem("") !== null) {
    throw new Error(`${dir} holds a run already: resume or discard it.`);
  }
  if (command !== "start" && store.getItem("") === null) throw new Error(`${dir} holds no run.`);

  let runner: TuneRunner;
  const transport = new SerialTransport(api, {
    onLog: ({ kind, text }) => {
      if (kind === "ok" || kind === "err") say(`log: ${text}`);
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
  // gains and ESC settings back. A second one leaves at once.
  process.once("SIGINT", () => {
    say("Pausing after this spin-up; Ctrl-C again to leave at once.");
    runner.pause();
    process.once("SIGINT", () => {
      runner.abandon();
      process.exit(130);
    });
  });

  // A run left mid-way gets its TUNE dropped and any ESC settings it owes put back first.
  await runner.connected();

  if (command === "discard") {
    await runner.discard();
    if (runner.getRun() !== null) throw new Error("The ESCs' own settings could not be put back.");
  } else if (command === "resume") {
    runner.resume(device);
    await idle(runner);
  } else {
    const schema = await transport.requestWhole<Schema>("DUMP_SCHEMA", TIMEOUT_SCHEMA_MS);
    if (!schema) throw new Error("The blaster did not send its schema.");
    const baseline = baselineOf(device);
    if (!baseline) throw new Error("No motor is enabled.");
    const escs = draft!.kind === "esc" ? await readEscSettings(transport, escTargets(device)) : [];
    const rows = searchableRows(escs);
    const unknown = Object.keys(draft!.esc).filter((name) => !rows.some((r) => r.field.name === name));
    if (unknown.length > 0) {
      const names = escRows(escs).filter((r) => r.field.searchable).map((r) => r.field.name);
      throw new Error(`No searchable ESC setting is named ${unknown.join(", ")}: there are ${names.join(", ")}.`);
    }
    const config = configOf(draft!, gainMaxOf(schema), rows);
    if (typeof config === "string") throw new Error(config);
    await runner.start(config, baseline, device);
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  },
);
