// The ESC passthrough session's wire protocols: MSP v1 to open it, then the BLHeli 4-way interface
// to reach each ESC's AM32 bootloader through the blaster.
//
// Ported from kelly-esc's tools/fourway.py, which is proven against Trifolium's passthrough (the
// rp2040-passthrough library, 4Way.cpp and MSP.cpp). Framing follows Betaflight's msp.c and
// serial_4way.c, which that library copies. What the library does differently, and this client
// therefore relies on:
//
// - MSP_SET_PASSTHROUGH is recognised only without a payload (MSP.cpp matches it on checksum 0xF5),
//   and opens 4-way on every ESC pin the blaster handed over, answering with their count.
// - DeviceInitFlash answers 4 bytes: [signature low (0x06), flash size code, pin code, interface
//   mode]. The "471" greeting is checked on the blaster and never forwarded.
// - DeviceReset sends the bootloader its run command, then holds the line low for 300 ms, so the
//   ESC starts its app whatever its bootloader makes of a high line.
// - DeviceWrite is one bootloader program command, which erases the flash page first when the
//   address is the page's start. The settings block starts its page, so one write is one erase.

import type { ByteLink } from "../serial/transport";

const MSP_SET_PASSTHROUGH = 245;
const MSP_API_VERSION = 1;

export const CMD = {
  InterfaceTestAlive: 0x30,
  InterfaceExit: 0x34,
  DeviceReset: 0x35,
  DeviceInitFlash: 0x37,
  DeviceRead: 0x3a,
  DeviceWrite: 0x3b,
} as const;

export const ACK_OK = 0x00;
const ACK_I_INVALID_CHANNEL = 0x08;
const ACK_NAMES: Record<number, string> = {
  0x00: "ACK_OK",
  0x02: "ACK_I_INVALID_CMD",
  0x03: "ACK_I_INVALID_CRC",
  0x04: "ACK_I_VERIFY_ERROR",
  0x08: "ACK_I_INVALID_CHANNEL",
  0x09: "ACK_I_INVALID_PARAM",
  0x0f: "ACK_D_GENERAL_ERROR",
};

/**
 * AM32 bootloader flash size code -> where its settings block sits, as a 4-way address. As AM32's
 * checkDeviceInfo() and am32-configurator's mcu.ts. 128K parts put it at 0x1F800, past the 16-bit
 * address this library forwards, so they are refused rather than addressed wrongly.
 */
const SETTINGS_ADDRESS: Record<number, number> = { 0x1f: 0x7c00, 0x35: 0xf800 };

/** One frame's reply, then the next request: generous for a 256-byte one-wire read at 19200 baud. */
const REPLY_TIMEOUT_MS = 3000;

/** How long the blaster gets to start answering MSP once the port reopens in passthrough. */
const OPEN_DEADLINE_MS = 8000;

/**
 * How long an ESC gets to answer DeviceInitFlash. An ESC still in its app when the blaster rebooted
 * into passthrough resets itself 2 s after losing DShot and only then sits in its bootloader, and the
 * blaster spends 200 ms on each attempt it does not answer. Long enough, too, to plug a battery in
 * once the session is waiting - the recovery the error below describes.
 */
const INIT_DEADLINE_MS = 10000;
const INIT_RETRY_MS = 300;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

export const ackName = (ack: number): string =>
  ACK_NAMES[ack] ?? `ack 0x${ack.toString(16).padStart(2, "0")}`;

/** CRC-16/XMODEM, the 4-way frames' checksum. */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** A request: `$M<`, size, command, payload, XOR of everything after the header. */
export function mspFrame(command: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const body = Uint8Array.of(payload.length, command, ...payload);
  return Uint8Array.of(0x24, 0x4d, 0x3c, ...body, body.reduce((x, b) => x ^ b, 0));
}

/** A host frame: `/`, command, address, param count (0 meaning 256), params, CRC high first. */
export function fourwayFrame(command: number, address: number, params: Uint8Array): Uint8Array {
  if (params.length < 1 || params.length > 256) {
    throw new Error(`4-way params must be 1..256 bytes, got ${params.length}`);
  }
  if (address < 0 || address > 0xffff) throw new Error(`4-way address ${address} is not 16-bit`);
  const body = Uint8Array.of(
    0x2f,
    command,
    address >> 8,
    address & 0xff,
    params.length & 0xff,
    ...params,
  );
  const crc = crc16Xmodem(body);
  return Uint8Array.of(...body, crc >> 8, crc & 0xff);
}

export interface FourwayReply {
  command: number;
  address: number;
  params: Uint8Array;
  ack: number;
}

/** What a flash-size code says about where the settings live, or a loud refusal. */
export function settingsAddress(flashCode: number): number {
  const address = SETTINGS_ADDRESS[flashCode];
  if (address === undefined) {
    throw new Error(
      `ESC bootloader reports flash size code 0x${flashCode.toString(16)}, which this console` +
        " cannot address (it knows 32K 0x1f and 64K 0x35)",
    );
  }
  return address;
}

/** The 4-way client over a passthrough session's byte link. */
export class Fourway {
  /** Every ESC connect() reached, which are the ones to restart into their apps at the end. */
  readonly connected = new Set<number>();

  constructor(private link: ByteLink) {}

  /** One MSP request and its reply's payload. */
  private async msp(command: number): Promise<Uint8Array> {
    await this.link.write(mspFrame(command));
    const header = await this.link.read(5, REPLY_TIMEOUT_MS);
    const rest = await this.link.read(header[3] + 1, REPLY_TIMEOUT_MS);
    const raw = Uint8Array.of(...header, ...rest);
    if (header[0] !== 0x24 || header[1] !== 0x4d || header[2] !== 0x3e || header[4] !== command) {
      throw new Error(`MSP ${command}: unexpected reply [${hex(raw)}]`);
    }
    const payload = rest.subarray(0, -1);
    const checksum = mspFrame(command, payload);
    if (checksum[checksum.length - 1] !== rest[rest.length - 1]) {
      throw new Error(`MSP ${command}: bad checksum [${hex(raw)}]`);
    }
    return payload;
  }

  /**
   * Opens 4-way on every ESC the blaster handed over, returning how many that is.
   *
   * The port reopens before the blaster's passthrough loop is reading it, and bytes sent into that
   * gap may be lost or answered late. So MSP_API_VERSION, which changes nothing, is asked until it
   * answers; whatever late duplicates follow are drained, and only then is 4-way opened, once.
   */
  async open(): Promise<number> {
    const deadline = Date.now() + OPEN_DEADLINE_MS;
    for (;;) {
      try {
        await this.link.write(mspFrame(MSP_API_VERSION));
        await this.link.read(1, 500);
        break;
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error(`the blaster did not answer MSP in passthrough: ${(e as Error).message}`);
        }
      }
    }
    await this.link.drain(300);
    const reply = await this.msp(MSP_SET_PASSTHROUGH);
    if (reply.length !== 1) {
      throw new Error(`MSP_SET_PASSTHROUGH answered [${hex(reply)}], not a count`);
    }
    return reply[0];
  }

  /** One 4-way request and its reply, checked for framing, CRC and command but not for its ack. */
  async request(command: number, address: number, params: Uint8Array): Promise<FourwayReply> {
    await this.link.write(fourwayFrame(command, address, params));
    const header = await this.link.read(5, REPLY_TIMEOUT_MS);
    if (header[0] !== 0x2e) throw new Error(`4-way reply starts [${hex(header)}], not 0x2e`);
    const count = header[4] || 256;
    const rest = await this.link.read(count + 3, REPLY_TIMEOUT_MS);
    const raw = Uint8Array.of(...header, ...rest);
    const crc = (rest[count + 1] << 8) | rest[count + 2];
    if (crc !== crc16Xmodem(raw.subarray(0, -2))) {
      throw new Error(`4-way reply CRC mismatch [${hex(raw)}]`);
    }
    if (header[1] !== command) {
      throw new Error(
        `4-way reply is for command 0x${header[1].toString(16)}, not 0x${command.toString(16)}`,
      );
    }
    return {
      command,
      address: (header[2] << 8) | header[3],
      params: rest.subarray(0, count),
      ack: rest[count],
    };
  }

  /** request(), with anything but ACK_OK a loud error naming `what`. */
  private async expectOk(what: string, command: number, address: number, params: Uint8Array) {
    const reply = await this.request(command, address, params);
    if (reply.ack !== ACK_OK) throw new Error(`${what}: ${ackName(reply.ack)}`);
    return reply.params;
  }

  /**
   * Connects to ESC `esc`'s bootloader, retrying while it is still on its way there, and returns
   * where its settings block sits.
   */
  async connect(esc: number): Promise<number> {
    const deadline = Date.now() + INIT_DEADLINE_MS;
    for (;;) {
      const reply = await this.request(CMD.DeviceInitFlash, 0, Uint8Array.of(esc));
      // An index the blaster did not hand over: no retry makes it one.
      if (reply.ack === ACK_I_INVALID_CHANNEL) throw new Error(`the blaster has no ESC ${esc}`);
      if (reply.ack === ACK_OK) {
        if (reply.params.length !== 4) {
          throw new Error(`ESC ${esc} device info is [${hex(reply.params)}], not 4 bytes`);
        }
        this.connected.add(esc);
        return settingsAddress(reply.params[1]);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `ESC ${esc} bootloader did not answer (${ackName(reply.ack)}). Check the ESC is ` +
            "powered. If it still fails, unplug the battery, start the read again and plug the " +
            "battery in while it waits: an ESC powered up on a line held high stays in its " +
            "bootloader.",
        );
      }
      await new Promise((r) => setTimeout(r, INIT_RETRY_MS));
    }
  }

  async read(address: number, count: number): Promise<Uint8Array> {
    const where = `0x${address.toString(16)}`;
    const params = Uint8Array.of(count & 0xff);
    const what = `read ${count} bytes at ${where}`;
    const data = await this.expectOk(what, CMD.DeviceRead, address, params);
    if (data.length !== count) {
      throw new Error(`read at ${where} returned ${data.length} of ${count} bytes`);
    }
    return data;
  }

  async write(address: number, data: Uint8Array): Promise<void> {
    const what = `write ${data.length} bytes at 0x${address.toString(16)}`;
    await this.expectOk(what, CMD.DeviceWrite, address, data);
  }

  /** Starts ESC `esc`'s app. The ESC must have been connected in this session. */
  async reset(esc: number): Promise<void> {
    await this.expectOk(`reset ESC ${esc}`, CMD.DeviceReset, 0, Uint8Array.of(esc));
  }

  async exit(): Promise<void> {
    await this.expectOk("leave 4-way", CMD.InterfaceExit, 0, Uint8Array.of(0));
  }
}
