// The tune CLI's ways to a blaster, as the Web Serial ports transport.ts drives: a USB serial port
// through serialport, or the simulator's serial over TCP (serve.py's socket://host:port).
//
// Each open() connects afresh, as Web Serial's does, so the transport's reopen after a reboot works
// unchanged. The far end going away closes the readable, which ends the transport's read loop the
// way an unplugged Web Serial port does.

import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { SerialPort } from "serialport";
import { CMD } from "../esc/fourway";
import type { Port, SerialApi } from "../serial/transport";

/**
 * Where a port reports its traffic, to time it: each open and close, each MSP and 4-way frame sent,
 * and each chunk read, timed from the last write. `text` marks a chunk read after a text command
 * rather than a passthrough frame, which a caller may leave out: a capture is hundreds of them.
 */
export type Trace = (line: string, text: boolean) => void;

const NAMES = new Map<number, string>(Object.entries(CMD).map(([name, code]) => [code, name]));

const hex = (bytes: Uint8Array) => {
  const shown = [...bytes.subarray(0, 24)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `[${shown}${bytes.length > 24 ? " ..." : ""}] ${bytes.length} B`;
};

/** A frame the passthrough session sends, by name, or null for the firmware's text commands. */
function frameName(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x24) return `MSP ${bytes[4]}`;
  if (bytes[0] === 0x2f) return `4-way ${NAMES.get(bytes[1]) ?? `0x${bytes[1].toString(16)}`} ${bytes[5]}`;
  return null;
}

/** An open connection, and what ends it: serialport's destroy() leaves the OS port open. */
interface Opened {
  stream: Duplex;
  close(): Promise<void>;
}

class DuplexPort implements Port {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private opened: Opened | null = null;

  constructor(
    readonly name: string,
    private info: SerialPortInfo,
    private opener: (baudRate: number) => Promise<Opened>,
    private trace: Trace,
  ) {}

  getInfo(): SerialPortInfo {
    return this.info;
  }

  async open(options: SerialOptions): Promise<void> {
    if (this.opened) throw new Error(`${this.name} is already open`);
    const opening = Date.now();
    this.opened = await this.opener(options.baudRate);
    this.trace(`port: opened in ${Date.now() - opening} ms`, false);
    const { stream } = this.opened;
    const trace = this.trace;
    let ended = false;
    let wroteAt = Date.now();
    let wroteText = true;
    let firstRead = true;
    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on("data", (chunk: Buffer) => {
          // Of a text reply, the chunk it starts in and each one that ends a line: when the reply
          // began arriving and when it was whole.
          if (!wroteText) trace(`port: < +${Date.now() - wroteAt} ms ${hex(chunk)}`, false);
          else if (firstRead || chunk.includes(0x0a)) {
            const text = JSON.stringify(chunk.toString("latin1").slice(-40));
            trace(`port: < +${Date.now() - wroteAt} ms ...${text} ${chunk.length} B`, true);
          }
          firstRead = false;
          if (!ended) controller.enqueue(new Uint8Array(chunk));
        });
        stream.on("close", () => {
          if (!ended) controller.close();
          ended = true;
        });
        stream.on("error", (e: Error) => {
          if (!ended) controller.error(e);
          ended = true;
        });
      },
      cancel() {
        ended = true;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const frame = frameName(chunk);
        wroteAt = Date.now();
        wroteText = frame === null;
        firstRead = true;
        if (frame !== null) trace(`port: > ${frame} ${hex(chunk)}`, false);
        return new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(chunk), (e) => (e ? reject(e) : resolve()));
        });
      },
    });
  }

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    this.readable = null;
    this.writable = null;
    if (!opened) return;
    const closing = Date.now();
    await opened.close();
    this.trace(`port: closed in ${Date.now() - closing} ms`, false);
  }
}

/** What every Trifolium enumerates as, which the simulator's serial stands in for too. */
const BLASTER = { usbVendorId: 0x2e8a, usbProductId: 0x000a };

/**
 * Every USB serial port plugged in, which the transport narrows to blasters by USB identity. macOS
 * lists each as /dev/tty.*, the side that waits for a call in; the console calls out, on /dev/cu.*.
 */
export const usbSerialApi = (trace: Trace): SerialApi => ({
  async getPorts() {
    const listed = await SerialPort.list();
    return listed
      .filter((p) => p.vendorId && p.productId)
      .map((p) => {
        const path = p.path.replace(/^\/dev\/tty\./, "/dev/cu.");
        const info = { usbVendorId: parseInt(p.vendorId!, 16), usbProductId: parseInt(p.productId!, 16) };
        return new DuplexPort(path, info, async (baudRate) => {
          const port = new SerialPort({ path, baudRate, autoOpen: false });
          await new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
          // A write's callback means the kernel has the bytes, not that they went out, and closing
          // a port opened non-blocking, as serialport opens it, throws away what has not: the 4-way
          // reset that restarts the ESCs, last before passthrough ends. So it drains first. Both
          // error once the device has gone, which leaves nothing to send or close.
          const close = async () => {
            const draining = Date.now();
            await new Promise<void>((resolve) => port.drain(() => resolve()));
            trace(`port: drained in ${Date.now() - draining} ms`, false);
            await new Promise<void>((resolve) => port.close(() => resolve()));
          };
          return { stream: port, close };
        }, trace);
      });
  },
  requestPort: () =>
    Promise.reject(new Error("plug in exactly one blaster: with none or several, there is no picker")),
});

/** The simulator's serial at `url`, socket://host:port. */
export function tcpSerialApi(url: string, trace: Trace): SerialApi {
  const match = /^socket:\/\/([^:/]+):(\d+)$/.exec(url);
  if (!match) throw new Error(`${url} is not socket://host:port`);
  const [, host, port] = match;
  const only = new DuplexPort(url, BLASTER, () =>
    new Promise<Opened>((resolve, reject) => {
      const socket = connect({ host, port: Number(port) });
      const close = () =>
        new Promise<void>((done) => {
          if (socket.destroyed) return done();
          socket.once("close", () => done());
          socket.destroy();
        });
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve({ stream: socket, close });
      });
      socket.once("error", reject);
    }),
    trace,
  );
  return { getPorts: async () => [only], requestPort: async () => only };
}
