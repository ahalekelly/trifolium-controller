// Drives a run on the blaster: one spin-up at a time, through the same switch a person holds.
//
// Each spin-up waits for every wheel to stop and rest, sets the candidate with TUNE, holds Rev for
// the rampup timeout plus a settling time, lets go, and reads the capture the firmware dumps. Rev
// goes through HOLD, so SAFE, the menu and the rev safety latch govern it exactly as they govern
// the switch. TUNE lives in RAM, so a run leaves the stored settings as they were, and a reboot
// mid-run (a pack swap) costs nothing: every spin-up sends it again. A run that stops for any
// reason sends a bare TUNE, which puts the blaster's own settings back once its wheels stop - or,
// when a dropped link stopped it, the next connection does.

import { getByKey } from "../schema/keyPath";
import { sleep } from "../serial/sleep";
import type { Capture, CommandAck, SerialTransport } from "../serial/transport";
import type { MotorsDump } from "../ui/MotorActions";
import {
  BASELINE,
  loadRun,
  measure,
  nextSet,
  saveRun,
  startRun,
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

export class TuneRunner {
  /** Read from the browser by load(), once the Tune tab first opens. */
  private run: Saved = null;
  private loaded = false;
  private listeners = new Set<() => void>();
  private pauseWanted = false;
  private looping = false;
  private captureWaiter: ((capture: Capture) => void) | null = null;

  constructor(private transport: SerialTransport) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRun = () => this.run;

  /** Whether a run is driving the blaster. */
  running = () => this.looping;

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

  /** Every capture the transport assembles. One that arrives with no spin-up waiting is ignored. */
  capture(capture: Capture) {
    this.captureWaiter?.(capture);
  }

  start(config: TuneConfig, baseline: Gains, device: unknown) {
    if (this.looping) throw new Error("a run is already going");
    void this.loop(startRun(config, baseline), device);
  }

  resume(device: unknown) {
    if (this.looping || this.run === null || this.run === "unreadable") return;
    void this.loop({ ...this.run, status: "running", note: null }, device);
  }

  /** Stops after the spin-up under way; a set it leaves half done is dropped. */
  pause() {
    this.pauseWanted = true;
  }

  discard() {
    if (this.looping) throw new Error("pause the run first");
    this.set(null);
  }

  /** A blaster just connected: whatever TUNE a dropped link left on it goes. */
  connected() {
    if (!this.looping) void this.untune();
  }

  /** The page is going: the bare TUNE goes out with no time to hear the answer. */
  abandon() {
    if (this.looping && this.transport.connected) void this.transport.sendLine("TUNE");
  }

  private untune() {
    if (this.transport.connected) return this.transport.request<CommandAck>("TUNE");
  }

  private async loop(run: Run, device: unknown) {
    this.looping = true;
    this.pauseWanted = false;
    // Every change to `run` goes through here, so it stays the run this.run holds.
    const update = (next: Run) => this.set((run = next));
    update(run);
    try {
      const settings = runSettings(device);
      if (typeof settings === "string") throw new Error(settings);
      for (;;) {
        const { search, next } = nextSet(run);
        if (next === null) {
          update({ ...run, search, status: "done" });
          return;
        }
        const gains =
          next === BASELINE ? run.baseline : run.candidates.find((c) => c.id === next)!.gains;
        const spinups: Spinup[] = [];
        const traces: number[][] = [];
        for (const rpm of run.config.rpms) {
          if (this.pauseWanted) {
            update({ ...run, status: "paused", note: null });
            return;
          }
          const { spinup, trace } = await this.spinup(
            gains,
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
        update({
          ...run,
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
      update({ ...run, status: "paused", note: (e as Error).message });
    } finally {
      this.looping = false;
      this.notify();
      await this.untune();
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
