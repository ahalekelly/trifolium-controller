// Runs driven against a fake blaster: TUNE and DUMP_MOTORS answered as the firmware does, and each
// rev's hold kept, timed out or lost as the test says, with the capture the firmware dumps after.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capture, SerialTransport } from "../serial/transport";
import { DEFAULT_CONFIG, type Run, type TuneConfig } from "./run";
import { TuneRunner } from "./runner";

vi.mock("../serial/sleep", () => ({
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

const DEVICE = {
  useRpmLogging: true,
  rpmLogLength: 1200,
  rampupTimeout_ms: 500,
  batteryType: "4s",
  motorConfig: [{ enabled: true }],
};
const GAINS = { control: "pid" as const, kp: 0.2, ki: 0.5 };
/** One candidate, its two sets between the baselines: four sets. */
const CONFIG: TuneConfig = { ...DEFAULT_CONFIG, kp: [0.2], ki: [1], n: 2 };

const capture = (rpm: number, report: Capture["report"]): Capture => ({
  csv: [
    "Voltage_mv,Motor 1,TargetRPM 1,Throttle 1,value 1,",
    `16400,0,${rpm},1999,0.00,`,
    `16300,${rpm},${rpm},1500,0.00,`,
  ].join("\n"),
  report,
});

/** What becomes of each rev, in turn; every rev after the list's end keeps its hold. */
type Rev = "held" | "timeout" | "late";

function rig(revs: Rev[]) {
  const logged: string[] = [];
  const saved: string[] = [];
  let rpm = 0;
  let runner: TuneRunner;
  const transport = {
    connected: true,
    log: (_kind: string, text: string) => void logged.push(text),
    sendLine: async () => {},
    request: async (command: string) => {
      if (command === "DUMP_MOTORS") {
        return {
          menuOpen: false,
          burstMode: "auto",
          revAllowed: true,
          flywheelState: 0,
          motors: [{ enabled: true, targetRPM: 0, motorRPM: 0 }],
        };
      }
      if (command !== "TUNE") rpm = JSON.parse(command.slice(5)).revRPM;
      return { cmd: "TUNE", ok: true };
    },
    holdRev: (_mask: number, onLost: (why: string) => void) => {
      const rev = revs.shift() ?? "held";
      const at = rpm;
      if (rev === "held") {
        return () =>
          void setTimeout(
            () => runner.capture(capture(at, { readyMs: 300, slowestMotor: 1, timedOut: false })),
            100,
          );
      }
      // The firmware dumps a capture either way: a timed-out rev refuses its renewals, and a late
      // renewal lets the lease lapse mid-rev.
      setTimeout(() => {
        onLost(
          rev === "timeout"
            ? "the blaster refused it (rev aborted - let go to rev again)"
            : "renewals fell 321 ms apart",
        );
        const report =
          rev === "timeout"
            ? { readyMs: null, slowestMotor: 1, timedOut: true }
            : { readyMs: 300, slowestMotor: 1, timedOut: false };
        runner.capture(capture(at, report));
      }, 200);
      return () => {};
    },
  } as unknown as SerialTransport;
  runner = new TuneRunner(transport, (_, name) => void saved.push(name));
  return { runner, logged, saved };
}

const runOf = (runner: TuneRunner) => runner.getRun() as Run;

/** Moves fake time on until the runner stops looping. */
async function finish(runner: TuneRunner) {
  for (let i = 0; i < 2000; i++) {
    if (!(runner as unknown as { looping: boolean }).looping) return;
    await vi.advanceTimersByTimeAsync(250);
  }
  throw new Error("the run never stopped");
}

beforeEach(() => {
  vi.useFakeTimers();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a lost hold", () => {
  it("redoes the spin-up, keeping only the redo's capture", async () => {
    const { runner, logged, saved } = rig(["held", "late"]);
    runner.start(CONFIG, GAINS, DEVICE);
    await finish(runner);
    const run = runOf(runner);
    expect(run.status).toBe("done");
    expect(run.sets.map((s) => s.spinups[0].readyMs)).toEqual([300, 300, 300, 300]);
    expect(saved).toHaveLength(4);
    expect(new Set(saved).size).toBe(4);
    expect(logged).toEqual([
      "The console let go of Rev (renewals fell 321 ms apart); redoing the spin-up.",
    ]);
  });

  it("pauses the run once three tries running lose it", async () => {
    const { runner, logged, saved } = rig(["held", "late", "late", "late"]);
    runner.start(CONFIG, GAINS, DEVICE);
    await finish(runner);
    const run = runOf(runner);
    expect(run.status).toBe("paused");
    expect(run.note).toBe(
      "The console let go of Rev 3 times running: renewals fell 321 ms apart.",
    );
    expect(run.sets).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(logged).toHaveLength(2);
  });

  it("counts only tries in a row: a kept hold starts the count again", async () => {
    const { runner } = rig(["late", "late", "held", "late", "late"]);
    runner.start(CONFIG, GAINS, DEVICE);
    await finish(runner);
    expect(runOf(runner).status).toBe("done");
  });

  it("scores a spin-up the rampup timeout ended, rather than redoing it", async () => {
    const { runner, logged } = rig(["held", "timeout"]);
    runner.start(CONFIG, GAINS, DEVICE);
    await finish(runner);
    const run = runOf(runner);
    expect(run.status).toBe("done");
    expect(run.sets.map((s) => s.spinups[0].readyMs)).toEqual([300, null, 300, 300]);
    expect(logged).toEqual([]);
  });
});
