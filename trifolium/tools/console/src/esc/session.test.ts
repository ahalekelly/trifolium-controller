// Reads and writes against a fake blaster in passthrough with AM32 ESCs behind it - see
// fakeBlaster.ts for what it answers and on whose word.

import { describe, expect, it } from "vitest";
import { FakeBlaster } from "./fakeBlaster";
import { CMD, Fourway } from "./fourway";
import { escTargets, readEscs, writeEscs } from "./session";
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

  it("fails loudly when a block does not read back as written", async () => {
    const blaster = twoEscs();
    blaster.escs[1].corruptByte = 25;
    await expect(
      writeEscs(new Fourway(blaster), [0, 1], { advance_level: 30 }, quiet),
    ).rejects.toThrow(/ESC 1 settings did not verify: byte 25/);
  });

  it("refuses an ESC whose layout has no table, writing nothing", async () => {
    const blaster = twoEscs();
    blaster.escs[0].block[1] = 2;
    await expect(writeEscs(new Fourway(blaster), [0, 1], {}, quiet)).rejects.toThrow(/layout 2/);
    expect(blaster.writes).toEqual([]);
  });
});
