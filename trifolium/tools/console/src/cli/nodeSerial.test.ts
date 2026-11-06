// The Node ports under the real transport: a TCP server stands in for the blaster, answering
// DUMP_BOOT as the firmware does, and serialport's listing is faked.

import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialTransport } from "../serial/transport";
import { tcpSerialApi, usbSerialApi } from "./nodeSerial";

vi.mock("serialport", () => ({
  SerialPort: {
    list: async () => [
      { path: "/dev/tty.Bluetooth-Incoming-Port" },
      { path: "/dev/tty.usbmodem101", vendorId: "2e8a", productId: "000a" },
      { path: "/dev/tty.usbserial-1", vendorId: "0403", productId: "6001" },
    ],
  },
}));

let server: Server;
const sockets: Socket[] = [];

/** A blaster on a TCP port: it answers each DUMP_BOOT, and reports every line it got. */
async function blaster(lines: string[]): Promise<string> {
  server = createServer((socket) => {
    sockets.push(socket);
    let partial = "";
    socket.on("data", (chunk) => {
      const got = (partial + chunk.toString()).split("\n");
      partial = got.pop()!;
      for (const line of got) {
        lines.push(line);
        if (line === "DUMP_BOOT") socket.write('{"cmd":"DUMP_BOOT","chipId":"E6614103E7"}\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `socket://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise((resolve) => server?.close(resolve));
});

describe("the TCP port", () => {
  it("carries the transport's lines both ways, then ends its reads when the far end goes", async () => {
    const lines: string[] = [];
    const url = await blaster(lines);
    const disconnected: string[] = [];
    const transport = new SerialTransport(tcpSerialApi(url), {
      onDisconnect: (why) => void disconnected.push(why),
    });
    expect(await transport.connect()).toBe(true);
    expect(await transport.waitReady()).toBe(true);
    expect(transport.chipId).toBe("E6614103E7");
    expect(lines).toEqual(["DUMP_BOOT"]);

    sockets[0].destroy(); // the blaster rebooting
    await vi.waitFor(() => expect(disconnected).toHaveLength(1));
    expect(transport.connected).toBe(false);
  });

  it("opens again after a close, as a reboot's reopen needs", async () => {
    const url = await blaster([]);
    const [port] = await tcpSerialApi(url).getPorts();
    await port.open({ baudRate: 115200 });
    await port.close();
    await port.open({ baudRate: 115200 });
    expect(port.readable).not.toBeNull();
    await port.close();
  });

  it("refuses a URL that is not socket://host:port", () => {
    expect(() => tcpSerialApi("/dev/cu.usbmodem101")).toThrow("is not socket://host:port");
  });
});

describe("the USB ports", () => {
  it("lists every USB serial port by its call-out path and USB identity", async () => {
    const ports = await usbSerialApi.getPorts();
    expect(ports.map((p) => p.getInfo())).toEqual([
      { usbVendorId: 0x2e8a, usbProductId: 0x000a },
      { usbVendorId: 0x0403, usbProductId: 0x6001 },
    ]);
    expect(ports.map((p) => (p as unknown as { name: string }).name)).toEqual([
      "/dev/cu.usbmodem101",
      "/dev/cu.usbserial-1",
    ]);
  });
});
