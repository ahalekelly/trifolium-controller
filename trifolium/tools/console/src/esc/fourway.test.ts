// The frames are byte traces from kelly-esc's tools/fourway.py (msp_frame, fourway_frame), which is
// proven against Trifolium's passthrough; the DeviceInitFlash reply is Bruxa's AM32 greeting as the
// passthrough forwards it.

import { describe, expect, it } from "vitest";
import { ByteQueue } from "../serial/transport";
import { FakeBlaster, fourwayReply } from "./fakeBlaster";
import { CMD, Fourway, crc16Xmodem, fourwayFrame, mspFrame, settingsAddress } from "./fourway";

const bytes = (text: string) => Uint8Array.from(text.split(" "), (b) => parseInt(b, 16));
const BLOCK = new Uint8Array(192);

describe("framing", () => {
  it("computes CRC-16/XMODEM's check value", () => {
    expect(crc16Xmodem(new TextEncoder().encode("123456789"))).toBe(0x31c3);
  });

  it("frames MSP requests as fourway.py does, MSP_SET_PASSTHROUGH without a payload", () => {
    expect(mspFrame(245)).toEqual(bytes("24 4d 3c 00 f5 f5"));
    expect(mspFrame(1)).toEqual(bytes("24 4d 3c 00 01 01"));
  });

  it("frames 4-way requests as fourway.py does", () => {
    expect(fourwayFrame(CMD.DeviceInitFlash, 0, Uint8Array.of(1))).toEqual(bytes("2f 37 00 00 01 01 b8 21"));
    expect(fourwayFrame(CMD.DeviceRead, 0x7c00, Uint8Array.of(192))).toEqual(bytes("2f 3a 7c 00 01 c0 5d 71"));
    expect(fourwayFrame(CMD.DeviceReset, 0, Uint8Array.of(1))).toEqual(bytes("2f 35 00 00 01 01 fc a2"));
    expect(fourwayFrame(CMD.InterfaceExit, 0, Uint8Array.of(0))).toEqual(bytes("2f 34 00 00 01 00 46 d2"));
  });

  it("encodes 256 params as a count of 0 and refuses what does not fit", () => {
    expect(fourwayFrame(CMD.DeviceWrite, 0x7c00, new Uint8Array(256))[4]).toBe(0);
    expect(() => fourwayFrame(CMD.DeviceWrite, 0, new Uint8Array(0))).toThrow();
    expect(() => fourwayFrame(CMD.DeviceRead, 0x1f800, Uint8Array.of(1))).toThrow(/16-bit/);
  });

  it("frames replies the way the passthrough does", () => {
    expect(fourwayReply(CMD.DeviceInitFlash, 0, bytes("06 1f 14 04"), 0)).toEqual(
      bytes("2e 37 00 00 04 06 1f 14 04 00 12 5a"),
    );
  });
});

describe("settingsAddress", () => {
  it("places the settings by flash size code", () => {
    expect(settingsAddress(0x1f)).toBe(0x7c00);
    expect(settingsAddress(0x35)).toBe(0xf800);
  });

  it("refuses a 128K part, whose settings sit past a 16-bit address", () => {
    expect(() => settingsAddress(0x2b)).toThrow(/0x2b/);
  });
});

/** A link that answers every write with fixed bytes. */
const scripted = (...replies: Uint8Array[]) => {
  const queue = new ByteQueue();
  return {
    write: async () => {
      const next = replies.shift();
      if (next) queue.push(next);
    },
    read: (n: number, t: number) => queue.read(n, t),
    drain: async () => queue.clear(),
  };
};

describe("Fourway", () => {
  it("opens passthrough and reports the blaster's ESC count", async () => {
    expect(await new Fourway(new FakeBlaster([{ block: BLOCK }, { block: BLOCK }])).open()).toBe(2);
  });

  it("finds Bruxa's settings from its greeting", async () => {
    const fourway = new Fourway(scripted(bytes("2e 37 00 00 04 06 1f 14 04 00 12 5a")));
    expect(await fourway.connect(0)).toBe(0x7c00);
    expect([...fourway.connected]).toEqual([0]);
  });

  it("retries an ESC still on its way into its bootloader", async () => {
    const blaster = new FakeBlaster([{ block: BLOCK, initFailures: 2 }]);
    expect(await new Fourway(blaster).connect(0)).toBe(0x7c00);
    expect(blaster.log.filter(([c]) => c === CMD.DeviceInitFlash)).toHaveLength(3);
  });

  it("gives up at once on an ESC the blaster did not hand over", async () => {
    await expect(new Fourway(new FakeBlaster([{ block: BLOCK }])).connect(3)).rejects.toThrow(
      /no ESC 3/,
    );
  });

  it("refuses a reply whose CRC does not match", async () => {
    const reply = bytes("2e 37 00 00 04 06 1f 14 04 00 12 5b");
    await expect(new Fourway(scripted(reply)).connect(0)).rejects.toThrow(/CRC/);
  });

  it("refuses a reply to another command", async () => {
    const reply = fourwayReply(CMD.DeviceRead, 0, Uint8Array.of(0), 0);
    await expect(new Fourway(scripted(reply)).exit()).rejects.toThrow(/command 0x3a/);
  });

  it("names a refused request's ack", async () => {
    const reply = fourwayReply(CMD.DeviceRead, 0x7c00, Uint8Array.of(0), 0x0f);
    await expect(new Fourway(scripted(reply)).read(0x7c00, 192)).rejects.toThrow(/ACK_D_GENERAL_ERROR/);
  });

  it("times out loudly when nothing answers", async () => {
    await expect(new Fourway(scripted()).request(CMD.InterfaceTestAlive, 0, Uint8Array.of(0)))
      .rejects.toThrow(/timed out/);
  }, 5000);
});

describe("ByteQueue", () => {
  it("takes reads across chunk boundaries and waits for bytes still to come", async () => {
    const queue = new ByteQueue();
    queue.push(Uint8Array.of(1, 2));
    const pending = queue.read(3, 1000);
    queue.push(Uint8Array.of(3, 4));
    expect(await pending).toEqual(Uint8Array.of(1, 2, 3));
    expect(queue.clear()).toBe(1);
  });
});
