// serialPortAt() against a real tty: a pty whose far end echoes each write 200 ms later. Every read
// waits on serialport's poller, which is where a reply could stall until some unrelated timer ran.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { serialPortAt } from "./nodeSerial";

const ECHO_MS = 200;
let echo: ChildProcess;

afterEach(() => void echo?.kill());

describe.skipIf(process.platform === "win32")("a serial port", () => {
  it("hands over each reply as it arrives, not on some later timer", async () => {
    echo = spawn("python3", [new URL("./testdata/slowEcho.py", import.meta.url).pathname]);
    const lines = createInterface({ input: echo.stdout! })[Symbol.asyncIterator]();
    const path = (await lines.next()).value as string;
    const port = serialPortAt(path, {}, () => {});
    await port.open({ baudRate: 115200 });
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const sent = Date.now();
      await writer.write(new TextEncoder().encode("ping\n"));
      await reader.read();
      times.push(Date.now() - sent);
    }
    reader.releaseLock();
    writer.releaseLock();
    await port.close();
    for (const ms of times) expect(ms).toBeLessThan(ECHO_MS + 100);
  });
});
