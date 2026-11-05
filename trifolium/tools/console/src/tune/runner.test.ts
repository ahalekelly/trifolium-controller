// ESC runs driven against a fake blaster: TUNE, DUMP_MOTORS and Rev answered as the firmware does,
// RPM captures whose spin-up time follows the ESCs' startup power, and ESC passthrough sessions on
// fakeBlaster.ts's AM32 ESCs. The simulator has no AM32, so this is where the write cycle is tested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBlaster } from "../esc/fakeBlaster";
import { LAYOUTS } from "../esc/layouts";
import { readEscSettings, writeEscSettings } from "../esc/session";
import { V4_DEFAULT } from "../esc/testdata";
import type { Capture, SerialTransport } from "../serial/transport";
import { BASELINE, DEFAULT_CONFIG, plannedEscWrites, type Run, type TuneConfig } from "./run";
import { TuneRunner, type EscIo } from "./runner";

vi.mock("../serial/sleep", () => ({
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

/** startup_power's byte. A spin-up takes 500 ms less the ESCs' startup power. */
const POWER = 25;
const ORIGINAL_POWER = V4_DEFAULT[POWER];

const DEVICE = {
  useRpmLogging: true,
  rpmLogLength: 1200,
  rampupTimeout_ms: 500,
  batteryType: "4s",
  flywheelControl: "pid",
  motorConfig: [
    { enabled: true, kp: 0.2, ki: 0.5 },
    { enabled: true, kp: 0.2, ki: 0.5 },
  ],
  pusherDrive: "fet",
};
const GAINS = { control: "pid" as const, kp: 0.2, ki: 0.5 };

/** Three startup powers, two sets each: one round of three blocks, then the finalists are done. */
const CONFIG: TuneConfig = {
  ...DEFAULT_CONFIG,
  grid: {
    kind: "esc",
    fields: [
      {
        field: LAYOUTS[4].fields.find((f) => f.name === "startup_power")!,
        values: [80, 120, 150],
      },
    ],
  },
  n: 2,
};
const C80 = "Startup power 80 %";
const C120 = "Startup power 120 %";
const C150 = "Startup power 150 %";

const capture = (rpm: number, readyMs: number): Capture => ({
  csv: [
    "Voltage_mv,Motor 1,TargetRPM 1,Throttle 1,value 1,",
    `16400,0,${rpm},1999,0.00,`,
    `16300,${rpm},${rpm},1500,0.00,`,
  ].join("\n"),
  report: { readyMs, slowestMotor: 1, timedOut: false },
});

/**
 * A blaster with two flywheel ESCs, its transport, and the runner on it. `events` logs what decides
 * the order of things: TUNE, each passthrough session, the blaster answering after one, and each
 * rev with the startup power both ESCs held.
 */
function rig() {
  const escs = new FakeBlaster([{ block: V4_DEFAULT.slice() }, { block: V4_DEFAULT.slice() }]);
  const events: string[] = [];
  const blaster = {
    up: true,
    chipId: "E6614103E7345B2F",
    escs,
    events,
    runner: null as unknown as TuneRunner,
  };
  let rpm = 0;
  const transport = {
    get connected() {
      return blaster.up;
    },
    get chipId() {
      return blaster.up ? blaster.chipId : null;
    },
    log: () => {},
    sendLine: async (line: string) => void events.push(line),
    request: async (command: string) => {
      if (!blaster.up) return null;
      if (command === "DUMP_MOTORS") {
        return {
          menuOpen: false,
          burstMode: "auto",
          revAllowed: true,
          flywheelState: 0,
          motors: [1, 2].map(() => ({ enabled: true, targetRPM: 0, motorRPM: 0, erpmSeen: true })),
        };
      }
      events.push(command);
      if (command !== "TUNE") rpm = JSON.parse(command.slice(5)).revRPM;
      return { cmd: "TUNE", ok: true };
    },
    holdRev: () => {
      const power = escs.escs.map((e) => e.block[POWER]);
      events.push(`rev at ${power.join("/")}`);
      return () => {
        const at = rpm;
        setTimeout(() => {
          if (blaster.up) blaster.runner.capture(capture(at, 500 - power[0]));
        }, 100);
      };
    },
    command: async (text: string) => {
      events.push(text);
      return { cmd: text, ok: blaster.up, rebooting: true };
    },
    reopenAfterReboot: async () => blaster.up,
    waitReady: async () => {
      events.push("ready");
      return true;
    },
    disconnect: async () => {},
    binaryLink: () => escs,
  } as unknown as SerialTransport;
  const targets = { motors: [1, 2], pusherEsc: false };
  const io: EscIo = {
    read: () => readEscSettings(transport, targets),
    write: (values) => writeEscSettings(transport, targets, values),
  };
  const saved: string[] = [];
  const runnerOn = () =>
    (blaster.runner = new TuneRunner(transport, io, (_, name) => void saved.push(name)));
  runnerOn();
  return { ...blaster, blaster, runnerOn, saved };
}

const runOf = (runner: TuneRunner) => runner.getRun() as Run;

/** Moves fake time on until `done`. */
async function until(done: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (done()) return;
    await vi.advanceTimersByTimeAsync(250);
  }
  throw new Error("never happened");
}

/** Until the runner has stopped driving the blaster. */
const idle = (runner: TuneRunner) =>
  until(() => !(runner as unknown as { working: boolean }).working);

/** Each set's spin-up took the time its own settings give: the ESCs held them for it. */
function expectMeasuredOnItsOwnSettings(run: Run) {
  for (const set of run.sets) {
    const settings = set.id === BASELINE ? run.baseline : run.candidates.find((c) => c.id === set.id)!;
    expect(set.spinups[0].readyMs, set.id).toBe(500 - settings.esc!.startup_power);
  }
}

/** The run's sets as blocks: each id where it differs from the set before. */
const blocksOf = (run: Run) => run.sets.map((s) => s.id).filter((id, i, ids) => id !== ids[i - 1]);

const sessions = (events: string[]) => events.filter((e) => e === "ESC_PASSTHROUGH").length;

beforeEach(() => {
  vi.useFakeTimers();
  // Where a run lives across a reload.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an ESC run", () => {
  it("writes each candidate once for its block, measures it there, and ends on the ESCs' own", async () => {
    const { runner, escs, events } = rig();
    void runner.start(CONFIG, GAINS, DEVICE);
    await idle(runner);

    const run = runOf(runner);
    expect(run.status).toBe("done");
    expect(run.baseline.esc).toEqual({ startup_power: ORIGINAL_POWER });
    expectMeasuredOnItsOwnSettings(run);
    // The opening read leaves the ESCs on the baseline; every later block is one write.
    expect(blocksOf(run)).toEqual([BASELINE, C80, C120, C150, BASELINE]);
    expect(sessions(events)).toBe(5);
    expect(run.escWrites).toBe(4);
    expect(run.escWrites).toBe(plannedEscWrites(3, 2));
    // Every write restarts the blaster, and it answers again before the next rev.
    events.forEach((e, i) => {
      if (e !== "ESC_PASSTHROUGH") return;
      const next = events.slice(i + 1).find((later) => later === "ready" || later.startsWith("rev"));
      expect(next).toBe("ready");
    });
    // It closed on a baseline block, so the ESCs already hold what they started with.
    expect(run.restoreEscs).toBe(false);
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);
    expect(events[events.length - 1]).toBe("TUNE");
  });

  it("pauses on a write that fails, saying what the ESC said, and puts back the ESCs' own", async () => {
    const { runner, escs } = rig();
    escs.escs[1].corrupt = { byte: POWER, writes: 1 };
    void runner.start(CONFIG, GAINS, DEVICE);
    await idle(runner);

    const run = runOf(runner);
    expect(run.status).toBe("paused");
    expect(run.note).toMatch(
      /^ESC 1 did not take its new settings \(byte 25 .*\); its original settings are back and verified\. ESC 0 took the new values\.$/,
    );
    expect(blocksOf(run)).toEqual([BASELINE]);
    // The failed write, then the baseline's settings back.
    expect(run.escWrites).toBe(2);
    expect(run.restoreEscs).toBe(false);
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);
  });

  it("puts back the ESCs' own on Pause, and writes the candidate again before Resume measures", async () => {
    const { runner, escs, events } = rig();
    void runner.start(CONFIG, GAINS, DEVICE);
    await until(() => events.includes("rev at 80/80"));
    runner.pause();
    await idle(runner);

    let run = runOf(runner);
    expect(run.status).toBe("paused");
    expect(run.sets.map((s) => s.id)).toEqual([BASELINE, BASELINE, BASELINE, C80]);
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);
    expect(run.restoreEscs).toBe(false);

    runner.resume(DEVICE);
    await idle(runner);
    run = runOf(runner);
    expect(run.status).toBe("done");
    expectMeasuredOnItsOwnSettings(run);
    // Pausing cost two writes: the ESCs' own back, then the candidate again.
    expect(run.escWrites).toBe(plannedEscWrites(3, 2) + 2);
  });

  it("owes the ESCs' own across a dropped link and a reload, and puts them back on connecting", async () => {
    const { blaster, escs, events, runnerOn } = rig();
    void blaster.runner.start(CONFIG, GAINS, DEVICE);
    await until(() => events.includes("rev at 120/120"));
    blaster.up = false;
    await idle(blaster.runner);
    expect(runOf(blaster.runner)).toMatchObject({ status: "paused", restoreEscs: true });
    expect(escs.escs[0].block[POWER]).toBe(120);

    // The page reloads, and the blaster comes back.
    const runner = runnerOn();
    const shown: (string | null)[] = [];
    runner.subscribe(() => shown.push(runner.getActivity()));
    blaster.up = true;
    runner.connected();
    await idle(runner);
    expect(shown).toContain("Writing the original settings to the ESCs.");
    expect(runOf(runner).restoreEscs).toBe(false);
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);

    // The run picks up mid-block, on settings it writes again rather than assumes.
    runner.resume(DEVICE);
    await idle(runner);
    const run = runOf(runner);
    expect(run.status).toBe("done");
    expectMeasuredOnItsOwnSettings(run);
    expect(blocksOf(run)).toEqual([BASELINE, C80, C120, C150, BASELINE]);
  });

  it("puts the ESCs' own back before a run is discarded, but leaves an applied winner", async () => {
    const { blaster, escs, events } = rig();
    void blaster.runner.start(CONFIG, GAINS, DEVICE);
    await until(() => events.includes("rev at 80/80"));
    blaster.up = false;
    await idle(blaster.runner);
    // With nothing to put them back on, the run stays, still owing them.
    void blaster.runner.discard();
    await idle(blaster.runner);
    expect(runOf(blaster.runner).restoreEscs).toBe(true);
    blaster.up = true;
    void blaster.runner.discard();
    await idle(blaster.runner);
    expect(blaster.runner.getRun()).toBeNull();
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);

    void blaster.runner.start(CONFIG, GAINS, DEVICE);
    await idle(blaster.runner);
    const winner = runOf(blaster.runner).candidates.find((c) => c.id === C150)!;
    void blaster.runner.applyEsc(winner);
    await idle(blaster.runner);
    expect(runOf(blaster.runner).restoreEscs).toBe(false);
    void blaster.runner.discard();
    await idle(blaster.runner);
    expect(blaster.runner.getRun()).toBeNull();
    expect(escs.escs.map((e) => e.block[POWER])).toEqual([150, 150]);
  });

  it("keeps what it owes for its own blaster, refusing another loudly until it connects", async () => {
    const { blaster, escs, events } = rig();
    const { runner } = blaster;
    void runner.start(CONFIG, GAINS, DEVICE);
    await until(() => events.includes("rev at 120/120"));
    blaster.up = false;
    await idle(runner);
    expect(runOf(runner)).toMatchObject({ blaster: "E6614103E7345B2F", restoreEscs: true });

    // Another Trifolium connects: its ESCs are not the run's to write, nor its run to resume.
    blaster.chipId = "E66138935F4A2C27";
    blaster.up = true;
    const before = sessions(events);
    runner.connected();
    await idle(runner);
    const refused =
      "This run is for the blaster with chip ID E6614103E7345B2F, but the one connected is " +
      "E66138935F4A2C27. Connect that blaster to put its ESCs' own settings back, or Discard the " +
      "run, which leaves that blaster's ESCs on a candidate's settings.";
    expect(runOf(runner)).toMatchObject({ note: refused, restoreEscs: true });
    runner.resume(DEVICE);
    await idle(runner);
    expect(runOf(runner)).toMatchObject({ status: "paused", note: refused });
    expect(sessions(events)).toBe(before); // not even a read

    // Its own blaster gets them back.
    blaster.chipId = "E6614103E7345B2F";
    runner.connected();
    await idle(runner);
    expect(runOf(runner).restoreEscs).toBe(false);
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);
  });

  it("applies a winner on its own blaster only", async () => {
    const { blaster, escs } = rig();
    void blaster.runner.start(CONFIG, GAINS, DEVICE);
    await idle(blaster.runner);
    const winner = runOf(blaster.runner).candidates[0];
    blaster.chipId = "E66138935F4A2C27";
    const apply = vi.fn();
    blaster.runner.applyGains(winner, apply);
    void blaster.runner.applyEsc(winner);
    await idle(blaster.runner);
    expect(apply).not.toHaveBeenCalled();
    expect(escs.escs.map((e) => e.block)).toEqual([V4_DEFAULT, V4_DEFAULT]);
    expect(runOf(blaster.runner).note).toMatch(/^This run is for the blaster with chip ID E6614103E7345B2F/);
  });

  it("is dropped on Discard with another blaster connected, writing nothing", async () => {
    const { blaster, events } = rig();
    void blaster.runner.start(CONFIG, GAINS, DEVICE);
    await until(() => events.includes("rev at 120/120"));
    blaster.up = false;
    await idle(blaster.runner);
    blaster.chipId = "E66138935F4A2C27";
    blaster.up = true;
    const before = sessions(events);
    void blaster.runner.discard();
    await idle(blaster.runner);
    expect(blaster.runner.getRun()).toBeNull();
    expect(sessions(events)).toBe(before);
  });

  it("will not start on ESCs that differ on a setting it searches", async () => {
    const { runner, escs } = rig();
    escs.escs[1].block[POWER] = 120;
    await expect(runner.start(CONFIG, GAINS, DEVICE)).rejects.toThrow(
      /^The ESCs differ on Startup power \(100 %, 120 %\)/,
    );
    expect(runner.getRun()).toBeNull();
    expect(escs.writes).toEqual([]);
  });
});
