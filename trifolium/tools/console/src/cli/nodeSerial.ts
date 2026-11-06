// The tune CLI's ways to a blaster, as the Web Serial ports transport.ts drives: a USB serial port
// through serialport, or the simulator's serial over TCP (serve.py's socket://host:port).
//
// Each open() connects afresh, as Web Serial's does, so the transport's reopen after a reboot works
// unchanged. The far end going away closes the readable, which ends the transport's read loop the
// way an unplugged Web Serial port does.

import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { SerialPort } from "serialport";
import type { Port, SerialApi } from "../serial/transport";

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
  ) {}

  getInfo(): SerialPortInfo {
    return this.info;
  }

  async open(options: SerialOptions): Promise<void> {
    if (this.opened) throw new Error(`${this.name} is already open`);
    this.opened = await this.opener(options.baudRate);
    const { stream } = this.opened;
    let ended = false;
    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on("data", (chunk: Buffer) => {
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
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(chunk), (e) => (e ? reject(e) : resolve()));
        }),
    });
  }

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    this.readable = null;
    this.writable = null;
    await opened?.close();
  }
}

/** What every Trifolium enumerates as, which the simulator's serial stands in for too. */
const BLASTER = { usbVendorId: 0x2e8a, usbProductId: 0x000a };

/**
 * Every USB serial port plugged in, which the transport narrows to blasters by USB identity. macOS
 * lists each as /dev/tty.*, the side that waits for a call in; the console calls out, on /dev/cu.*.
 */
export const usbSerialApi: SerialApi = {
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
          // Its close() errors once the device has gone, which leaves nothing to close.
          const close = () => new Promise<void>((resolve) => port.close(() => resolve()));
          return { stream: port, close };
        });
      });
  },
  requestPort: () =>
    Promise.reject(new Error("plug in exactly one blaster: with none or several, there is no picker")),
};

/** The simulator's serial at `url`, socket://host:port. */
export function tcpSerialApi(url: string): SerialApi {
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
  );
  return { getPorts: async () => [only], requestPort: async () => only };
}
