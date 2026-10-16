// Drives a run on the blaster: one spin-up at a time, through the same switch a person holds.
//
// Each spin-up waits for every wheel to stop and rest, sets the candidate with TUNE, holds Rev for
// the rampup timeout plus a settling time, lets go, and reads the capture the firmware dumps. Rev
// goes through HOLD, so SAFE, the menu and the rev safety latch govern it exactly as they govern
// the switch. TUNE lives in RAM, so a run leaves the stored settings as they were, and a reboot
// mid-run (a pack swap) costs nothing: every spin-up sends it again. A run that stops for any
// reason sends a bare TUNE, which puts the blaster's own settings back once its wheels stop - or,
// when a dropped link stopped it, the next connection does.
//
// An ESC run writes a candidate's settings to the ESCs before its block of sets, and each write is
// a passthrough session that restarts the blaster, which is ready to rev again once it is back. The
// runner trusts only what it has read or written itself since it last started driving, so a resumed
// run writes its candidate again before measuring; a write the ESCs already match erases nothing.
// Whenever a run stops, the ESCs get the baseline's settings back unless they already hold them -
// or, when the link or the page went with it, at the next connection.

import type { EscSettings } from "../esc/session";
import { getByKey } from "../schema/keyPath";
import { sleep } from "../serial/sleep";
import type { Capture, CommandAck, SerialTransport } from "../serial/transport";
import type { MotorsDump } from "../ui/MotorActions";
import {
  BASELINE,
  escOriginals,
  loadRun,
  measure,
  nextSet,
  saveRun,
  startRun,
  type Candidate,
  type EscValues,
  type Gains,
  type Run,
  type Saved,
  type Spinup,
  type TuneConfig,
} from "./run";

/** Held past the rampup timeout, so a capture always shows the wheels settling after fire-ready. */
export const SETTLE_MS = 500;
/** Between a spin-up's wheels stopping and the next one starting. */
const REST_MS = 2000;
/** The longest the wheels may take to stop: dwell, idle and the spin-down ramp. */
const STOP_TIMEOUT_MS = 30000;
const STOP_POLL_MS = 250;
/** DUMP_MOTORS' flywheelState for flywheelState_t's STATE_IDLE. */
const STATE_IDLE = 0;

/** What a run needs from the device config, or why it will not do. */
export function runSettings(
  device: unknown,
): { holdMs: number; captureMs: number; cells: number } | string {
  const holdMs = Number(getByKey(device, "device:rampupTimeout_ms")) + SETTLE_MS;
  const captureMs = Number(getByKey(device, "device:rpmLogLength"));
  const cells = parseInt(String(getByKey(device, "device:batteryType")), 10); // "4s"
  if (getByKey(device, "device:useRpmLogging") !== true) {
    return "Turn on RPM Logging (RPM Log tab) and write it to the blaster first.";
  }
  if (captureMs < holdMs) {
    return `Capture Samples must be at least the rampup timeout plus ${SETTLE_MS} ms: ${holdMs}.`;
  }
  return { holdMs, captureMs, cells };
}

/**
 * The flywheel ESCs' settings, as esc/session.ts reads and writes them: each call is one passthrough
 * session, and returns with the blaster back in normal mode and answering.
 */
export interface EscIo {
  read(): Promise<EscSettings[]>;
  write(values: EscValues): Promise<EscSettings[]>;
}

export class TuneRunner {
  /** Read from the browser by load(), once the Tune tab first opens or a blaster connects. */
  private run: Saved = null;
  private loaded = false;
  /** What the runner is doing to the ESCs, while it does it. */
  private activity: string | null = null;
  private listeners = new Set<() => void>();
  private pauseWanted = false;
  /** Driving the blaster: a run, or ESC settings going back or on. */
  private working = false;
  private captureWaiter: ((capture: Capture) => void) | null = null;

  constructor(
    private transport: SerialTransport,
    private escs: EscIo,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRun = () => this.run;

  getActivity = () => this.activity;

  /** Whether the runner is driving the blaster: a run, or ESC settings going back or on. */
  running = () => this.working;

  /** The run saved in this browser, read the first time it is asked for. */
  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.run = loadRun();
  }

  private set(run: Run | null) {
    this.run = run;
    saveRun(run);
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private setWorking(working: boolean) {
    this.working = working;
    this.notify();
  }

  /** The run there is; only called where there is one. */
  private get current(): Run {
    if (this.run === null || this.run === "unreadable") throw new Error("there is no run");
    return this.run;
  }

  private change(patch: Partial<Run>) {
    this.set({ ...this.current, ...patch });
  }

  /** Runs `work` as the one thing driving the blaster, or not at all while something else is. */
  private async drive(work: () => Promise<void>) {
    if (this.working) return;
    this.setWorking(true);
    try {
      await work();
    } finally {
      this.setWorking(false);
    }
  }

  /** Every capture the transport assembles. One that arrives with no spin-up waiting is ignored. */
  capture(capture: Capture) {
    this.captureWaiter?.(capture);
  }

  /**
   * Starts a run from the blaster's own gains. An ESC run reads the ESCs first, for the settings it
   * puts back, which leaves them known to hold the baseline. Rejects when that read does.
   */
  async start(config: TuneConfig, gains: Gains, device: unknown) {
    if (this.working) throw new Error("a run is already going");
    let esc: EscValues | null = null;
    if (config.grid.kind === "esc") {
      this.setWorking(true);
      this.setActivity("Reading the ESCs' settings.");
      try {
        esc = escOriginals(await this.escs.read(), config.grid);
      } finally {
        this.setWorking(false);
        this.setActivity(null);
      }
    }
    this.set(startRun(config, { gains, esc }));
    void this.loop(esc ? BASELINE : null, device);
  }

  resume(device: unknown) {
    if (this.working || this.run === null || this.run === "unreadable") return;
    this.change({ status: "running", note: null });
    void this.loop(null, device);
  }

  /** Stops after the spin-up under way; a set it leaves half done is dropped. */
  pause() {
    this.pauseWanted = true;
  }

  /** Drops a run that is not going, once any ESC settings it owes are back. */
  async discard() {
    await this.drive(async () => {
      await this.settle();
      if (this.run !== "unreadable" && this.run?.restoreEscs) return; // the page says it is owed
      this.set(null);
    });
  }

  /** Writes an ESC run's winner to the ESCs, to stay. */
  async applyEsc(winner: Candidate) {
    await this.drive(async () => {
      this.change({ restoreEscs: true });
      try {
        await this.writeEscs(winner.esc!, winner.id);
        this.change({ restoreEscs: false });
        this.transport.log("ok", `Applied ${winner.id} to the ESCs.`);
      } catch (e) {
        this.change({ note: `Applying ${winner.id} failed: ${(e as Error).message}` });
      }
    });
  }

  /**
   * A blaster just connected: whatever TUNE a dropped link left on it goes, and so do ESC settings a
   * run that lost its link or its page owes back.
   */
  connected() {
    this.load();
    if (this.working) return;
    if (this.run === null || this.run === "unreadable" || !this.run.restoreEscs) {
      void this.untune();
      return;
    }
    void this.drive(async () => {
      await this.untune();
      await this.settle();
    });
  }

  /**
   * The page is going: the bare TUNE goes out with no time to hear the answer - unless an ESC
   * session has the port, where a line would land in the ESCs' passthrough.
   */
  abandon() {
    if (this.working && this.activity === null && this.transport.connected) {
      void this.transport.sendLine("TUNE");
    }
  }

  private untune() {
    if (this.transport.connected) return this.transport.request<CommandAck>("TUNE");
  }

  private setActivity(activity: string | null) {
    this.activity = activity;
    this.notify();
  }

  /** One write of `values` to every flywheel ESC, shown while it lasts and counted on the run. */
  private async writeEscs(values: EscValues, what: string) {
    this.setActivity(`Writing ${what} to the ESCs.`);
    try {
      await this.escs.write(values);
    } finally {
      this.setActivity(null);
      this.change({ escWrites: this.current.escWrites + 1 });
    }
  }

  /**
   * Puts back the baseline's ESC settings if the run owes them and the blaster is there to take
   * them. Returns why that failed, or null.
   */
  private async restoreEscs(): Promise<string | null> {
    const run = this.run;
    if (run === null || run === "unreadable" || !run.restoreEscs || !this.transport.connected) {
      return null;
    }
    try {
      await this.writeEscs(run.baseline.esc!, "the original settings");
      this.change({ restoreEscs: false });
      return null;
    } catch (e) {
      return `Putting the ESCs' original settings back failed: ${(e as Error).message}`;
    }
  }

  /** restoreEscs() for a run already stopped, whose note becomes why it failed. */
  private async settle() {
    const failed = await this.restoreEscs();
    if (failed) this.change({ note: failed });
  }

  /** `loaded` is what the ESCs are known to hold: a candidate's id, BASELINE, or null for unknown. */
  private async loop(loaded: string | null, device: unknown) {
    this.setWorking(true);
    this.pauseWanted = false;
    try {
      const settings = runSettings(device);
      if (typeof settings === "string") throw new Error(settings);
      for (;;) {
        const run = this.current;
        const { search, next } = nextSet(run);
        if (next === null) {
          this.change({ search, status: "done" });
          return;
        }
        if (this.pauseWanted) {
          this.change({ status: "paused", note: null });
          return;
        }
        const trial = next === BASELINE ? run.baseline : run.candidates.find((c) => c.id === next)!;
        if (trial.esc && loaded !== next) {
          loaded = null;
          // Owed from before the write starts: a page closed partway leaves the ESCs in doubt.
          if (next !== BASELINE) this.change({ restoreEscs: true });
          await this.writeEscs(trial.esc, next === BASELINE ? "the original settings" : next);
          loaded = next;
          if (next === BASELINE) this.change({ restoreEscs: false });
        }
        const spinups: Spinup[] = [];
        const traces: number[][] = [];
        for (const rpm of run.config.rpms) {
          if (this.pauseWanted) {
            this.change({ status: "paused", note: null });
            return;
          }
          const { spinup, trace } = await this.spinup(
            trial.gains,
            rpm,
            settings.holdMs,
            settings.captureMs,
          );
          spinups.push(spinup);
          traces.push(trace);
        }
        const traceKept = next === BASELINE ? run.traces : { ...run.traces, [next]: traces };
        // Only the finalists' traces are charted, so a dropped candidate's go.
        for (const id of Object.keys(search.dropped)) delete traceKept[id];
        this.change({
          search,
          sets: [...run.sets, { id: next, at: Date.now(), spinups }],
          traces: traceKept,
        });
        const cellMv = Math.min(...spinups.map((s) => s.packMv)) / settings.cells;
        if (cellMv < run.config.pauseCellMv) {
          throw new Error(
            `The pack read ${(cellMv / 1000).toFixed(2)} V a cell, below ` +
              `${(run.config.pauseCellMv / 1000).toFixed(2)} V. Swap it, then Resume.`,
          );
        }
      }
    } catch (e) {
      // Whatever stopped it, a dropped link included, is the note the run pauses with.
      this.change({ status: "paused", note: (e as Error).message });
    } finally {
      try {
        await this.untune();
        const failed = await this.restoreEscs();
        const { note } = this.current;
        if (failed) this.change({ note: note ? `${note} ${failed}` : failed });
      } finally {
        this.setWorking(false);
      }
    }
  }

  private async spinup(gains: Gains, rpm: number, holdMs: number, captureMs: number) {
    await this.waitStopped();
    await sleep(REST_MS);

    const ack = await this.transport.request<CommandAck>(
      `TUNE ${JSON.stringify({ revRPM: rpm, ...gains })}`,
    );
    if (!ack) throw new Error("No answer to TUNE. Reconnect, then Resume.");
    if (!ack.ok) throw new Error(`The blaster refused TUNE: ${ack.err}.`);

    const capture = new Promise<Capture | null>((resolve) => {
      this.captureWaiter = resolve;
      void sleep(captureMs + 5000).then(() => resolve(null));
    });
    // Held for holdMs, or until the hold is lost, which leaves no capture worth waiting for.
    let lost: string | null = null;
    await new Promise<void>((resolve) => {
      const release = this.transport.hold("rev", (why) => {
        lost = why;
        resolve();
      });
      void sleep(holdMs).then(() => {
        release();
        resolve();
      });
    });
    if (lost) {
      this.captureWaiter = null;
      throw new Error(`The console let go of Rev: ${lost}.`);
    }
    const got = await capture;
    this.captureWaiter = null;

    if (!got) {
      throw new Error(
        "No RPM capture came back. Is the blaster still connected, and does its fire mode rev on " +
          "the Rev switch?",
      );
    }
    if (got.report.readyMs === null && !got.report.timedOut) {
      throw new Error("The rev ended before the wheels were at speed: SAFE, menu or cutoff.");
    }
    return measure(got, rpm, holdMs);
  }

  /**
   * Until the flywheels are idle with every enabled wheel's target and reading at 0 - TUNE's own
   * test, and a standstill - refusing to wait on a blaster that will not rev.
   */
  private async waitStopped() {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    for (;;) {
      const dump = await this.transport.poll<MotorsDump>("DUMP_MOTORS");
      if (!dump) throw new Error("No answer from the blaster. Reconnect, then Resume.");
      if (dump.menuOpen) throw new Error("The blaster's menu is open. Close it, then Resume.");
      if (dump.burstMode === "safe") throw new Error("The blaster is in SAFE. Leave it, then Resume.");
      if (!dump.revAllowed) throw new Error("The blaster will not rev. Is its pack at the cutoff?");
      const stopped = dump.motors.every(
        (m) => !m.enabled || (m.targetRPM === 0 && m.motorRPM === 0),
      );
      if (dump.flywheelState === STATE_IDLE && stopped) return;
      if (Date.now() > deadline) {
        throw new Error("The wheels did not stop within 30 s. Is Idle Mode on?");
      }
      await sleep(STOP_POLL_MS);
    }
  }
}
