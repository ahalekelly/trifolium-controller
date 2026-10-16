// Reading and writing every flywheel ESC's AM32 settings, through one ESC passthrough session.
//
// readEscSettings() and writeEscSettings() are the whole interface: each reboots the blaster into
// passthrough, does its work on every flywheel ESC, starts the ESCs' apps again and closes the
// port, which ends passthrough, then reopens it and waits until the blaster answers commands. The
// caller gets the blaster back in normal mode either way, and re-reads its config, since the
// disconnect cleared what the console had.
//
// AM32 keeps its settings in MCU flash, which wears out after some 10k erases, and a settings write
// is one erase. So a write reads every ESC first, changes only the named fields, and skips an ESC
// whose block would come out byte-identical. The values written are the same on every ESC; every
// byte not named keeps each ESC's own value (its direction, above all).

import { getByKey } from "../schema/keyPath";
import type { SerialTransport } from "../serial/transport";
import { Fourway } from "./fourway";
import { BLOCK_SIZE, layoutOf, withValues, type EscLayout } from "./layouts";

export interface EscSettings {
  /** Passthrough index: the blaster's enabled motors in motor order, then its pusher ESC. */
  esc: number;
  layout: EscLayout;
  block: Uint8Array;
}

/**
 * Which passthrough indices are flywheels, from device settings: the blaster hands over the pin of
 * every enabled motor, in order, then the pusher's when it is driven by an ESC. The pusher ESC is
 * counted so the session can check the blaster agrees, and is never read or written - it runs a
 * different motor.
 */
export interface EscTargets {
  /** The 1-based motor number of each flywheel ESC, which is its index here. */
  motors: number[];
  pusherEsc: boolean;
}

export function escTargets(device: unknown): EscTargets {
  const motors: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (getByKey(device, `device:motorConfig[${i}].enabled`) === true) motors.push(i + 1);
  }
  return { motors, pusherEsc: getByKey(device, "device:pusherDrive") === "esc" };
}

/** Connects to one ESC and reads its block. */
async function readOne(fourway: Fourway, esc: number) {
  const address = await fourway.connect(esc);
  const block = await fourway.read(address, BLOCK_SIZE);
  return { address, settings: { esc, layout: layoutOf(block), block } };
}

/** Every ESC's settings, in index order. */
export async function readEscs(fourway: Fourway, escs: number[]): Promise<EscSettings[]> {
  const out: EscSettings[] = [];
  for (const esc of escs) out.push((await readOne(fourway, esc)).settings);
  return out;
}

/**
 * Writes `values` (raw, by AM32 field name) to every ESC and returns what each holds after.
 *
 * Every ESC is read and every new block worked out before the first write, so a name or value one
 * ESC's layout refuses stops the write with none of them changed. Each write is read back; a block
 * that does not match is a loud error, with that ESC's write the last one attempted.
 */
export async function writeEscs(
  fourway: Fourway,
  escs: number[],
  values: Record<string, number>,
  log: (text: string) => void,
): Promise<EscSettings[]> {
  const read = [];
  for (const esc of escs) read.push(await readOne(fourway, esc));
  const planned = read.map(({ address, settings }) => ({
    address,
    settings,
    next: withValues(settings.block, values),
  }));

  const out: EscSettings[] = [];
  for (const { address, settings, next } of planned) {
    if (next.every((b, i) => b === settings.block[i])) {
      log(`ESC ${settings.esc} already holds these values - not written.`);
      out.push(settings);
      continue;
    }
    // Connected again: the ESCs share the one bootloader channel the last connect() pointed at.
    await fourway.connect(settings.esc);
    await fourway.write(address, next);
    const back = await fourway.read(address, BLOCK_SIZE);
    const wrong = back.findIndex((b, i) => b !== next[i]);
    if (wrong !== -1) {
      throw new Error(
        `ESC ${settings.esc} settings did not verify: byte ${wrong} reads back ${back[wrong]}, ` +
          `${next[wrong]} was written. Read the ESCs again before trusting their settings.`,
      );
    }
    log(`ESC ${settings.esc} written and verified.`);
    out.push({ esc: settings.esc, layout: settings.layout, block: back });
  }
  return out;
}

/**
 * Runs `work` inside an ESC passthrough session, and always ends it: every ESC connected is
 * restarted into its app, the port is closed, and the blaster is waited for in normal mode. An error
 * from `work` wins over one from the cleanup, which is still logged.
 */
async function inPassthrough<T>(
  transport: SerialTransport,
  targets: EscTargets,
  work: (fourway: Fourway, escs: number[]) => Promise<T>,
): Promise<T> {
  const ack = await transport.command("ESC_PASSTHROUGH");
  if (!ack?.ok) throw new Error(`the blaster refused ESC passthrough: ${ack?.err ?? "no reply"}`);
  if (!(await transport.reopenAfterReboot())) {
    throw new Error("the blaster did not come back in ESC passthrough");
  }

  const fourway = new Fourway(transport.binaryLink());
  let result: T | undefined;
  let failure: unknown = null;
  try {
    const count = await fourway.open();
    const expected = targets.motors.length + (targets.pusherEsc ? 1 : 0);
    if (count !== expected) {
      throw new Error(
        `the blaster handed over ${count} ESCs, but its settings have ${targets.motors.length} ` +
          `flywheel motors${targets.pusherEsc ? " and a pusher ESC" : ""}. A pin conflict at ` +
          "boot drops a motor; the boot faults say if one did",
      );
    }
    result = await work(fourway, targets.motors.map((_, i) => i));
  } catch (e) {
    failure = e;
  }

  // Each step on its own, so one ESC that does not answer still leaves the rest restarted.
  const steps = [...fourway.connected].map((esc) => () => fourway.reset(esc));
  for (const step of [...steps, () => fourway.exit()]) {
    try {
      await step();
    } catch (e) {
      transport.log("err", `Leaving ESC passthrough: ${(e as Error).message}`);
      failure ??= e;
    }
  }
  // Closing the port is what ends passthrough; the blaster falls through into a normal boot.
  await transport.disconnect("Closing ESC passthrough.", true);
  if (!((await transport.reopenAfterReboot()) && (await transport.waitReady()))) {
    failure ??= new Error("the blaster did not come back from ESC passthrough; reconnect it");
  }
  if (failure !== null) throw failure;
  return result as T;
}

/** Every flywheel ESC's settings. Leaves the blaster in normal mode. */
export const readEscSettings = (
  transport: SerialTransport,
  targets: EscTargets,
): Promise<EscSettings[]> => inPassthrough(transport, targets, readEscs);

/**
 * Writes `values` (raw, by AM32 field name) to every flywheel ESC, verified, and returns what each
 * holds after. Leaves the blaster in normal mode. This is the entry point for anything that tunes
 * ESC settings automatically: one call is one passthrough session and at most one flash erase per
 * ESC, none for an ESC that already holds the values.
 */
export const writeEscSettings = (
  transport: SerialTransport,
  targets: EscTargets,
  values: Record<string, number>,
): Promise<EscSettings[]> =>
  inPassthrough(transport, targets, (fourway, escs) =>
    writeEscs(fourway, escs, values, (text) => transport.log("ok", text)),
  );
