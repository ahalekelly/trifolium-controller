import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_OPTIONS,
  SerialTransport,
  askUntilWhole,
  blasterPorts,
  CaptureAssembler,
  captureReport,
  configFrom,
  isReply,
  openOptionsFor,
  repliesTo,
  serialApi,
  type SerialApi,
  type Capture,
  type LogLine,
} from "./transport";
import { sleep } from "./sleep";
import { SerialPort as UsbSerialPort, serial as usbSerial } from "../vendor/web-serial-polyfill/dist/serial.js";
import deviceJson from "../fixtures/device.json";
import profile0 from "../fixtures/profile0.json";

// The fixtures are captures of the config the firmware serialises; the framing the dumps put in
// front of it is added here, the way serialCommands.cpp does.
const deviceDump = JSON.stringify({ cmd: "DUMP_DEVICE", ...deviceJson });
const profileDump = (index: number) =>
  JSON.stringify({ cmd: "DUMP_PROFILE", index, ...profile0 });

describe("opening a port", () => {
  it("buffers the largest RPM capture on Web Serial: 2000 rows of up to 241 bytes", () => {
    const native = {} as SerialApi;
    expect(openOptionsFor(native)).toBe(OPEN_OPTIONS);
    expect(OPEN_OPTIONS.bufferSize).toBeGreaterThanOrEqual(2000 * 241);
  });

  /** A blaster on WebUSB, as the polyfill sees one, that records each read it is asked for. */
  function blasterOverUsb() {
    const asked: number[] = [];
    const endpoint = (direction: string, endpointNumber: number) => ({ direction, endpointNumber, packetSize: 64 });
    const device = {
      opened: false,
      configuration: {},
      configurations: [
        {
          interfaces: [
            { interfaceNumber: 0, alternates: [{ interfaceClass: 2, endpoints: [] }] },
            { interfaceNumber: 1, alternates: [{ interfaceClass: 10, endpoints: [endpoint("in", 1), endpoint("out", 2)] }] },
          ],
        },
      ],
      open: async () => { device.opened = true; },
      close: async () => { device.opened = false; },
      claimInterface: async () => {},
      controlTransferOut: async () => ({ status: "ok" }),
      transferIn: (_endpoint: number, length: number) => {
        asked.push(length);
        return new Promise(() => {}); // the blaster has nothing to say
      },
    };
    return { port: new UsbSerialPort(device), asked };
  }

  it("asks a phone for USB reads of 256 bytes, as the polyfill does by default", async () => {
    const { port, asked } = blasterOverUsb();
    await port.open(openOptionsFor(usbSerial));
    void port.readable!.getReader().read();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([256]);
  });

  it("would ask a phone for half a megabyte in one USB read with Web Serial's buffer", async () => {
    // What the RPM capture's buffer did to Android: the polyfill reads its bufferSize at once.
    const { port, asked } = blasterOverUsb();
    await port.open(OPEN_OPTIONS);
    void port.readable!.getReader().read();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([512 * 1024]);
  });
});

describe("isReply", () => {
  it("accepts a JSON line and rejects volunteered events", () => {
    expect(isReply(deviceDump)).toBe(true);
    expect(isReply('{"evt":"unconfigured"}')).toBe(false);
    expect(isReply("Trifolium 2.1.0")).toBe(false);
  });
});

describe("repliesTo", () => {
  it("matches a reply on its cmd field, with or without whitespace", () => {
    expect(repliesTo("DUMP_BOOT")('{"cmd":"DUMP_BOOT","ok":true}')).toBe(true);
    expect(repliesTo("DUMP_SCHEMA")('{"cmd": "DUMP_SCHEMA","tree":[]}')).toBe(true);
    expect(repliesTo("DUMP_DEVICE")(deviceDump)).toBe(true);
  });

  it("does not take one command's reply for another's", () => {
    expect(repliesTo("DUMP_SCHEMA")('{"cmd":"DUMP_BOOT","ok":true}')).toBe(false);
    expect(repliesTo("DUMP_DEVICE")(profileDump(0))).toBe(false);
    expect(repliesTo("DUMP_PROFILE")(deviceDump)).toBe(false);
  });

  it("matches the slot a command names, not just the command", () => {
    expect(repliesTo("DUMP_PROFILE 1")(profileDump(1))).toBe(true);
    // The crosstalk the index exists for: slot 0's body, arriving late, is not slot 1's reply.
    expect(repliesTo("DUMP_PROFILE 1")(profileDump(0))).toBe(false);
    expect(repliesTo("FACTORY_RESET_PROFILE 2")('{"cmd":"FACTORY_RESET_PROFILE","ok":true,"index":2}'))
      .toBe(true);
    expect(repliesTo("FACTORY_RESET_PROFILE 2")('{"cmd":"FACTORY_RESET_PROFILE","ok":true,"index":1}'))
      .toBe(false);
  });

  it("does not match a slot on a leading digit of a longer index", () => {
    expect(repliesTo("DUMP_PROFILE 1")('{"cmd":"DUMP_PROFILE","index":12}')).toBe(false);
  });

  it("takes any slot when the command names none", () => {
    // Bare DUMP_PROFILE dumps whichever slot is active, which the caller does not know up front.
    expect(repliesTo("DUMP_PROFILE")(profileDump(2))).toBe(true);
    expect(repliesTo("  DUMP_BOOT  ")('{"cmd":"DUMP_BOOT","ok":true}')).toBe(true);
  });
});

describe("captureReport", () => {
  it("reads the report that closes a capture", () => {
    expect(captureReport('{"evt":"rpmCapture","readyMs":178,"slowestMotor":3,"timedOut":false,"maxThrottle":1999}')).toEqual(
      { readyMs: 178, slowestMotor: 3, timedOut: false, maxThrottle: 1999 },
    );
    expect(captureReport('{"evt":"rpmCapture","readyMs":null,"slowestMotor":1,"timedOut":true,"maxThrottle":1999}')).toEqual(
      { readyMs: null, slowestMotor: 1, timedOut: true, maxThrottle: 1999 },
    );
  });

  it("ignores every other line", () => {
    expect(captureReport('{"evt":"unconfigured"}')).toBe(null);
    expect(captureReport("16390,0,30000,7143,0.00,")).toBe(null);
    expect(captureReport('{"evt":"rpmCapture","readyMs":17')).toBe(null);
  });
});

vi.mock("./sleep", () => ({ sleep: vi.fn() }));


describe("CaptureAssembler", () => {
  it("hands over a capture's rows once its report arrives, past the chatter around them", () => {
    const got: Capture[] = [];
    const captures = new CaptureAssembler((capture) => got.push(capture));
    const report = '{"evt":"rpmCapture","readyMs":178,"slowestMotor":1,"timedOut":false,"maxThrottle":1999}';
    const lines = [
      "[info] revving",
      "Voltage_mv,Motor 1,TargetRPM 1,Throttle 1,value 1,",
      "16390,0,30000,1115,0.00,",
      "[warn] from the other core",
      "16380,812,30000,1999,0.00,",
      report,
      report,
    ];
    expect(lines.map((line) => captures.take(line))).toEqual([
      false, true, true, false, true, true, false,
    ]);
    expect(got).toEqual([
      {
        csv: [lines[1], lines[2], lines[4]].join("\n"),
        report: { readyMs: 178, slowestMotor: 1, timedOut: false, maxThrottle: 1999 },
      },
    ]);
  });
});

describe("configFrom", () => {
  it("drops the framing and keeps the config", () => {
    const config = configFrom(JSON.parse(profileDump(1))) as Record<string, unknown>;
    expect(config).not.toHaveProperty("cmd");
    expect(config).not.toHaveProperty("index");
    expect(config).toEqual(profile0);
  });

  it("leaves a dump that carries no framing alone", () => {
    expect(configFrom({ ...deviceJson })).toEqual(deviceJson);
  });

  it("does not mutate the reply it was given", () => {
    const reply = { cmd: "DUMP_DEVICE", blasterName: "Diana" };
    configFrom(reply);
    expect(reply.cmd).toBe("DUMP_DEVICE");
  });

  it("passes a non-object through rather than throwing", () => {
    expect(configFrom(null)).toBe(null);
    expect(configFrom(undefined)).toBe(undefined);
  });
});

describe("askUntilWhole", () => {
  /** Answers with each line in turn, counting how often it was asked. */
  const answers = (...lines: (string | null)[]) => {
    const asked = { count: 0 };
    return { asked, ask: async () => lines[Math.min(asked.count++, lines.length - 1)] };
  };

  it("asks again when a reply arrives garbled, and takes the whole one", async () => {
    // What a verbose boot did to a reply: another core's log line spliced into it.
    const { asked, ask } = answers('{"cmd":"DUMP_SCHEMA","tr1006 [INFO] Booting', '{"cmd":"DUMP_SCHEMA"}');
    const garbled: boolean[] = [];
    const reply = await askUntilWhole<{ cmd: string }>(ask, (_, last) => garbled.push(last));
    expect(reply?.cmd).toBe("DUMP_SCHEMA");
    expect(asked.count).toBe(2);
    expect(garbled).toEqual([false]);
  });

  it("gives up after three garbled replies", async () => {
    const { asked, ask } = answers("{broken");
    const garbled: boolean[] = [];
    expect(await askUntilWhole(ask, (_, last) => garbled.push(last))).toBeNull();
    expect(asked.count).toBe(3);
    expect(garbled).toEqual([false, false, true]);
  });

  it("takes silence as final rather than waiting again", async () => {
    const { asked, ask } = answers(null);
    expect(await askUntilWhole(ask, () => {})).toBeNull();
    expect(asked.count).toBe(1);
  });
});

describe("blasterPorts", () => {
  const port = (info: SerialPortInfo) => ({ getInfo: () => info }) as unknown as SerialPort;

  it("keeps a blaster and drops what else the browser has allowed", () => {
    // The bench's allowed list: a Bluetooth serial link, which reports no USB ids, and a Pico debug
    // probe beside the blaster.
    const blaster = port({ usbVendorId: 0x2e8a, usbProductId: 0x000a });
    const bluetooth = port({});
    const probe = port({ usbVendorId: 0x2e8a, usbProductId: 0x000c });
    expect(blasterPorts([bluetooth, blaster, probe])).toEqual([blaster]);
  });

  it("keeps every blaster, which connect() then asks between", () => {
    const a = port({ usbVendorId: 0x2e8a, usbProductId: 0x000a });
    const b = port({ usbVendorId: 0x2e8a, usbProductId: 0x000a });
    expect(blasterPorts([a, b])).toEqual([a, b]);
  });
});

describe("serialApi", () => {
  const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0";
  const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile";
  const native = { requestPort: async () => null, getPorts: async () => [] };
  const usb = {};

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes Web Serial on a desktop browser that also has WebUSB", () => {
    vi.stubGlobal("navigator", { userAgent: DESKTOP, serial: native, usb });
    expect(serialApi()).toBe(native);
    expect(SerialTransport.supported).toBe(true);
  });

  it("takes the WebUSB polyfill where there is no Web Serial", () => {
    vi.stubGlobal("navigator", { userAgent: DESKTOP, usb });
    expect(serialApi()).toBe(usbSerial);
  });

  it("takes the WebUSB polyfill on Android even when Web Serial exists", () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID, serial: native, usb });
    expect(serialApi()).toBe(usbSerial);
  });

  it("takes the WebUSB polyfill on Android in Desktop site mode, which hides Android", () => {
    const desktopSite = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0";
    vi.stubGlobal("navigator", { userAgent: desktopSite, serial: native, usb, contacts: {} });
    expect(serialApi()).toBe(usbSerial);
    expect(SerialTransport.asksEveryTime).toBe(true);
  });

  it("remembers a blaster everywhere but Android over WebUSB", () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID, serial: native, usb });
    expect(SerialTransport.asksEveryTime).toBe(true);
    vi.stubGlobal("navigator", { userAgent: DESKTOP, serial: native, usb });
    expect(SerialTransport.asksEveryTime).toBe(false);
    vi.stubGlobal("navigator", { userAgent: DESKTOP, usb }); // WebUSB, but a desktop keeps permission
    expect(SerialTransport.asksEveryTime).toBe(false);
  });

  it("falls back to Android's Web Serial when there is no WebUSB", () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID, serial: native });
    expect(serialApi()).toBe(native);
  });

  it("reports unsupported with neither", () => {
    vi.stubGlobal("navigator", { userAgent: DESKTOP });
    expect(serialApi()).toBeNull();
    expect(SerialTransport.supported).toBe(false);
  });
});

describe("a reboot on Android", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile";

  /** A blaster on WebUSB that never says anything, as the polyfill opens one. */
  const blaster = () => {
    const device = {
      opened: false,
      configuration: {},
      configurations: [
        {
          interfaces: [
            { interfaceNumber: 0, alternates: [{ interfaceClass: 2, endpoints: [] }] },
            {
              interfaceNumber: 1,
              alternates: [
                {
                  interfaceClass: 10,
                  endpoints: [
                    { direction: "in", endpointNumber: 1, packetSize: 64 },
                    { direction: "out", endpointNumber: 2, packetSize: 64 },
                  ],
                },
              ],
            },
          ],
        },
      ],
      open: async () => { device.opened = true; },
      close: async () => { device.opened = false; },
      claimInterface: async () => {},
      controlTransferOut: async () => ({ status: "ok" }),
      transferIn: () => new Promise(() => {}),
      transferOut: async () => ({ status: "ok" }),
    };
    return device;
  };

  /** Android's WebUSB: the picker grants a device; the page's known devices are the stale one. */
  function phone() {
    const before = blaster();
    const usb = {
      picked: 0,
      requestDevice: async () => {
        usb.picked++;
        return usb.picked === 1 ? before : blaster();
      },
      getDevices: vi.fn(async () => [before]), // still listed, though the reboot disconnected it
    };
    vi.stubGlobal("navigator", { userAgent: ANDROID, usb });
    return usb;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for Connect instead of polling, then carries on through the picker", async () => {
    const usb = phone();
    const transport = new SerialTransport();
    expect(await transport.connect(false)).toBe(true);
    await transport.disconnect("Rebooting.", true);

    const reopened = transport.reopenAfterReboot();
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.awaitingReconnect).toBe(true);
    expect(usb.getDevices).not.toHaveBeenCalled();

    expect(await transport.connect(false)).toBe(true);
    expect(await reopened).toBe(true);
    expect(usb.picked).toBe(2); // the picker both times, never the disconnected device
    expect(transport.awaitingReconnect).toBe(false);
    expect(transport.connected).toBe(true);
  });
});

describe("SerialTransport over real streams", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A blaster that answers each line within the write that carried it - the fastest a device can
   * be, and the case a listener registered after the write misses.
   */
  const instantBlaster = (answer: (line: string) => string) => {
    let device!: ReadableStreamDefaultController<Uint8Array>;
    const port = {
      readable: new ReadableStream<Uint8Array>({ start: (c) => void (device = c) }),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          const line = new TextDecoder().decode(chunk).trim();
          device.enqueue(new TextEncoder().encode(`${answer(line)}\n`));
        },
      }),
      open: async () => {},
      close: async () => {},
      getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 0x000a }),
    };
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0",
      serial: { getPorts: async () => [port], requestPort: async () => port },
    });
  };

  it("catches a reply that arrives before the write returns", async () => {
    instantBlaster((line) =>
      line === "DUMP_BOOT" ? '{"cmd":"DUMP_BOOT","chipId":"E6614103E7345B2F"}' : deviceDump,
    );
    const transport = new SerialTransport();
    expect(await transport.connect()).toBe(true);
    expect(await transport.waitReady(1, 500)).toBe(true);
    expect(transport.chipId).toBe("E6614103E7345B2F");
    expect(await transport.request("DUMP_DEVICE", 500)).toEqual(JSON.parse(deviceDump));
    expect(await transport.requestWhole("DUMP_DEVICE", 500)).toEqual(JSON.parse(deviceDump));
    await transport.disconnect();
  });

  /** Holds a rev through `renewals` renewals against a blaster answering `answer`. */
  async function heldRev(renewals: number, answer: (line: string) => string) {
    const written: string[] = [];
    instantBlaster((line) => {
      written.push(line);
      return answer(line);
    });
    const transport = new SerialTransport();
    expect(await transport.connect()).toBe(true);
    let lost: { why: string; revved: boolean } | null = null;
    let release = () => {};
    let left = renewals;
    vi.mocked(sleep).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 1)); // the reply's turn to arrive, as 100 ms gives it
      if (--left === 0) release();
    });
    release = transport.holdRev(0b1010, (why, revved) => (lost = { why, revved }));
    await new Promise((r) => setTimeout(r, 20));
    await transport.disconnect();
    return { written, lost: lost as { why: string; revved: boolean } | null };
  }

  it("holds with REV_HOLD, keeps the lease with REV_RENEW, and lets go with REV_RELEASE", async () => {
    const ok = (line: string) => `{"cmd":"${line.split(" ")[0]}","ok":true,"index":10}`;
    const { written, lost } = await heldRev(3, ok);
    expect(written).toEqual(["REV_HOLD 10", "REV_RENEW", "REV_RENEW", "REV_RELEASE"]);
    expect(lost).toBeNull();
  });

  it("loses the hold, saying why, when the blaster refuses to rev or ends the rev", async () => {
    const safe = await heldRev(3, () => '{"cmd":"REV_HOLD","ok":false,"err":"SAFE"}');
    expect(safe.lost).toEqual({ why: "SAFE", revved: false });
    expect(safe.written).toEqual(["REV_HOLD 10", "REV_RELEASE"]);

    const lapsed = await heldRev(3, (line) =>
      line === "REV_RENEW"
        ? '{"cmd":"REV_RENEW","ok":false,"err":"no rev held - the lease ran out or it was let go"}'
        : '{"cmd":"REV_HOLD","ok":true,"index":10}',
    );
    expect(lapsed.lost).toEqual({
      why: "no rev held - the lease ran out or it was let go",
      revved: true,
    });
    expect(lapsed.written).toEqual(["REV_HOLD 10", "REV_RENEW", "REV_RELEASE"]);
  });

  it("hands every byte to the binary link, none to the log or a capture", async () => {
    instantBlaster((line) => line); // echoes, so what is written comes back as device output
    const logged: LogLine[] = [];
    const captured: Capture[] = [];
    const transport = new SerialTransport({
      onLog: (line) => logged.push(line),
      onCapture: (capture) => captured.push(capture),
    });
    expect(await transport.connect()).toBe(true);
    const link = transport.binaryLink();
    const lines = [
      "Voltage_mv,Motor 1,TargetRPM 1,Throttle 1,value 1,",
      "16390,0,30000,1115,0.00,",
      '{"evt":"rpmCapture","readyMs":178,"slowestMotor":1,"timedOut":false,"maxThrottle":1999}',
      "[info] chatter",
    ].join("\n");
    await link.write(new TextEncoder().encode(lines));
    const back = await link.read(lines.length + 1, 500);
    expect(new TextDecoder().decode(back)).toBe(`${lines}\n`);
    expect(logged.filter((l) => l.kind === "in")).toEqual([]);
    expect(captured).toEqual([]);
    await transport.disconnect();
  });
});
