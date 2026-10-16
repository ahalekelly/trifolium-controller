// Reads and writes against a fake blaster in passthrough with AM32 ESCs behind it - see
// fakeBlaster.ts for what it answers and on whose word.

import { describe, expect, it } from "vitest";
import { FakeBlaster } from "./fakeBlaster";
import { CMD, Fourway } from "./fourway";
import type { SerialTransport } from "../serial/transport";
import {
  EscsNotRestored,
  escTargets,
  readEscs,
  writeEscSettings,
  writeEscs,
} from "./session";
import { V4_DEFAULT } from "./testdata";

const quiet = () => {};

/** Two ESCs as a blaster has them: the same settings, opposite directions. */
const twoEscs = () => {
  const reversed = V4_DEFAULT.slice();
  reversed[17] = 1;
  return new FakeBlaster([{ block: V4_DEFAULT.slice() }, { block: reversed }]);
};

describe("escTargets", () => {
  it("numbers enabled motors in order and notes a pusher on an ESC", () => {
    const device = {
      motorConfig: [{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: true }],
      pusherDrive: "esc",
    };
    expect(escTargets(device)).toEqual({ motors: [2, 4], pusherEsc: true });
    expect(escTargets({ ...device, pusherDrive: "fet" }).pusherEsc).toBe(false);
  });
});

describe("readEscs", () => {
  it("reads each ESC's block and layout", async () => {
    const blaster = twoEscs();
    const escs = await readEscs(new Fourway(blaster), [0, 1]);
    expect(escs.map((e) => [e.esc, e.layout.version, e.block[17]])).toEqual([
      [0, 4, 0],
      [1, 4, 1],
    ]);
    expect(blaster.writes).toEqual([]);
  });
});

describe("writeEscs", () => {
  it("writes the same values to every ESC and keeps each one's own direction", async () => {
    const blaster = twoEscs();
    const escs = await writeEscs(new Fourway(blaster), [0, 1], { advance_level: 30 }, quiet);
    expect(blaster.writes).toEqual([0, 1]);
    expect(blaster.escs.map((e) => [e.block[23], e.block[17]])).toEqual([
      [30, 0],
      [30, 1],
    ]);
    expect(escs.map((e) => e.block[23])).toEqual([30, 30]);
  });

  it("verifies each write by reading it back", async () => {
    const blaster = twoEscs();
    await writeEscs(new Fourway(blaster), [0, 1], { advance_level: 30 }, quiet);
    const afterWrite = blaster.log.flatMap(([command], i) =>
      command === CMD.DeviceWrite ? [blaster.log[i + 1][0]] : [],
    );
    expect(afterWrite).toEqual([CMD.DeviceRead, CMD.DeviceRead]);
  });

  it("does not erase an ESC that already holds the values, and says so", async () => {
    const blaster = twoEscs();
    blaster.escs[1].block[23] = 30;
    const said: string[] = [];
    await writeEscs(new Fourway(blaster), [0, 1], { advance_level: 30 }, (t) => said.push(t));
    expect(blaster.writes).toEqual([0]);
    expect(said).toEqual([
      "ESC 0 written and verified.",
      "ESC 1 already holds these values - not written.",
    ]);
  });

  it("checks every ESC's values before writing any", async () => {
    const blaster = twoEscs();
    blaster.escs[1].block[1] = 3; // no brake_on_zero_throttle in v3
    await expect(
      writeEscs(new Fourway(blaster), [0, 1], { brake_on_zero_throttle: 1 }, quiet),
    ).rejects.toThrow(/layout 3 has no field brake_on_zero_throttle/);
    expect(blaster.writes).toEqual([]);
  });

  it("puts back an ESC's original block when its write does not verify", async () => {
    const blaster = twoEscs();
    const original = blaster.escs[1].block.slice();
    blaster.escs[1].corrupt = { byte: 25, writes: 1 };
    await expect(
      writeEscs(new Fourway(blaster), [0, 1], { advance_level: 30 }, quiet),
    ).rejects.toThrow(
      /ESC 1 did not take its new settings \(byte 25 .*\); its original settings are back and verified. ESC 0 took the new values/,
    );
    expect(blaster.escs[1].block).toEqual(original);
    expect(blaster.writes).toEqual([0, 1, 1]);
  });

  it("names an ESC whose original block will not go back either", async () => {
    const blaster = twoEscs();
    blaster.escs[0].corrupt = { byte: 0, writes: 2 };
    const failure = await writeEscs(new Fourway(blaster), [0, 1], { advance_level: 30 }, quiet)
      .then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(EscsNotRestored);
    expect((failure as EscsNotRestored).escs).toEqual([0]);
    expect((failure as Error).message).toMatch(/left in its bootloader/);
    expect(blaster.writes).toEqual([0, 0]); // ESC 1 never written
  });

  it("refuses an ESC whose layout has no table, writing nothing", async () => {
    const blaster = twoEscs();
    blaster.escs[0].block[1] = 2;
    await expect(writeEscs(new Fourway(blaster), [0, 1], {}, quiet)).rejects.toThrow(/layout 2/);
    expect(blaster.writes).toEqual([]);
  });
});

/**
 * The transport side of a passthrough session, around a fake blaster: the ack, the reboots and the
 * reconnects all succeed, so what is left to see is what the session sends the ESCs.
 */
const sessionOver = (blaster: FakeBlaster) => {
  const said: string[] = [];
  const transport = {
    command: async () => ({ cmd: "ESC_PASSTHROUGH", ok: true, rebooting: true }),
    reopenAfterReboot: async () => true,
    waitReady: async () => true,
    disconnect: async () => {},
    binaryLink: () => blaster,
    log: (_kind: string, text: string) => said.push(text),
  } as unknown as SerialTransport;
  return { transport, said };
};

describe("writeEscSettings", () => {
  const targets = { motors: [1, 2], pusherEsc: false };
  const resets = (blaster: FakeBlaster) =>
    blaster.log.filter(([command]) => command === CMD.DeviceReset).map(([, esc]) => esc);

  it("restarts every ESC it reached and leaves 4-way", async () => {
    const blaster = twoEscs();
    await writeEscSettings(sessionOver(blaster).transport, targets, { advance_level: 30 });
    expect(resets(blaster)).toEqual([0, 1]);
    expect(blaster.log[blaster.log.length - 1][0]).toBe(CMD.InterfaceExit);
  });

  it("restarts an ESC whose original block went back", async () => {
    const blaster = twoEscs();
    blaster.escs[1].corrupt = { byte: 25, writes: 1 };
    await expect(
      writeEscSettings(sessionOver(blaster).transport, targets, { advance_level: 30 }),
    ).rejects.toThrow(/original settings are back/);
    expect(resets(blaster)).toEqual([0, 1]);
  });

  it("leaves an ESC that could not be restored in its bootloader", async () => {
    const blaster = twoEscs();
    blaster.escs[1].corrupt = { byte: 0, writes: 2 };
    await expect(
      writeEscSettings(sessionOver(blaster).transport, targets, { advance_level: 30 }),
    ).rejects.toBeInstanceOf(EscsNotRestored);
    expect(resets(blaster)).toEqual([0]);
  });
});
