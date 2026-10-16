// A blaster in ESC passthrough with AM32 ESCs behind it, over a ByteLink, for the tests.
//
// Answers the way rp2040-passthrough's MSP.cpp and 4Way.cpp do, with each ESC's bootloader behind
// them as kelly-esc measured Bruxa's: DeviceInitFlash answers [06, flash code, pin, 04], a read
// returns the bytes at the address, and a write at the settings address replaces the block.

import { ByteQueue, type ByteLink } from "../serial/transport";
import { ACK_OK, CMD, crc16Xmodem } from "./fourway";

const ACK_D_GENERAL_ERROR = 0x0f;
const ACK_I_INVALID_CHANNEL = 0x08;
const SETTINGS = 0x7c00;

export interface FakeEsc {
  block: Uint8Array;
  /** DeviceInitFlash attempts this ESC ignores first, as one still on its way into its bootloader. */
  initFailures?: number;
  /** Flips `byte` of the next `writes` blocks written, as flash that did not take them. */
  corrupt?: { byte: number; writes: number };
}

export function fourwayReply(command: number, address: number, params: Uint8Array, ack: number) {
  const body = Uint8Array.of(0x2e, command, address >> 8, address & 0xff, params.length & 0xff, ...params, ack);
  const crc = crc16Xmodem(body);
  return Uint8Array.of(...body, crc >> 8, crc & 0xff);
}

export class FakeBlaster implements ByteLink {
  private queue = new ByteQueue();
  private current = -1;
  /** Every 4-way command received, in order, as [command, esc it addressed]. */
  readonly log: [number, number][] = [];
  /** The ESCs written, in order. */
  readonly writes: number[] = [];

  constructor(readonly escs: FakeEsc[]) {}

  async write(frame: Uint8Array): Promise<void> {
    if (frame[0] === 0x24) {
      const command = frame[4];
      const payload = command === 245 ? Uint8Array.of(this.escs.length) : Uint8Array.of(0, 1, 44);
      const body = Uint8Array.of(payload.length, command, ...payload);
      this.queue.push(Uint8Array.of(0x24, 0x4d, 0x3e, ...body, body.reduce((x, b) => x ^ b, 0)));
      return;
    }
    const [, command, hi, lo, count] = frame;
    const address = (hi << 8) | lo;
    const params = frame.subarray(5, 5 + (count || 256));
    const addressed = command === CMD.DeviceInitFlash || command === CMD.DeviceReset;
    this.log.push([command, addressed ? params[0] : this.current]);
    this.queue.push(this.answer(command, address, params));
  }

  private answer(command: number, address: number, params: Uint8Array): Uint8Array {
    const ok = (out: Uint8Array = Uint8Array.of(0)) => fourwayReply(command, address, out, ACK_OK);
    switch (command) {
      case CMD.DeviceInitFlash: {
        const esc = this.escs[params[0]];
        if (!esc) return fourwayReply(command, address, Uint8Array.of(0), ACK_I_INVALID_CHANNEL);
        this.current = params[0];
        if ((esc.initFailures ?? 0) > 0) {
          esc.initFailures!--;
          return fourwayReply(command, address, Uint8Array.of(0x06, 0x33, 0x67, 0x04), ACK_D_GENERAL_ERROR);
        }
        return ok(Uint8Array.of(0x06, 0x1f, 0x14, 0x04));
      }
      case CMD.DeviceRead: {
        const start = address - SETTINGS;
        return ok(this.escs[this.current].block.slice(start, start + (params[0] || 256)));
      }
      case CMD.DeviceWrite: {
        const esc = this.escs[this.current];
        if (address !== SETTINGS) throw new Error(`fake ESC only takes writes at its settings, not ${address}`);
        const block = params.slice();
        if (esc.corrupt && esc.corrupt.writes > 0) {
          esc.corrupt.writes--;
          block[esc.corrupt.byte] ^= 0xff;
        }
        esc.block = block;
        this.writes.push(this.current);
        return ok();
      }
      default:
        return ok();
    }
  }

  read(count: number, timeoutMs: number): Promise<Uint8Array> {
    return this.queue.read(count, timeoutMs);
  }

  async drain(): Promise<number> {
    return this.queue.clear();
  }
}
