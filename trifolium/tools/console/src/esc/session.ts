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
//
// A block that does not verify is not left to boot: a damaged byte can reverse a motor, and AM32's
// bootloader will not start the app at all unless byte 0 is 1. So a failed write puts the ESC's
// original block back and verifies that, and an ESC whose original will not go back either is left
// in its bootloader, where nothing it holds is run.

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
 * Writes `block` to one ESC and reads it back. Null when it verified, otherwise what went wrong -
 * a mismatch or the protocol's own error, since either leaves the block in doubt.
 */
async function writeVerified(
  fourway: Fourway,
  esc: number,
  address: number,
  block: Uint8Array,
): Promise<string | null> {
  try {
    // Connected again: the ESCs share the one bootloader channel the last connect() pointed at.
    await fourway.connect(esc);
    await fourway.write(address, block);
    const back = await fourway.read(address, BLOCK_SIZE);
    const wrong = back.findIndex((b, i) => b !== block[i]);
    return wrong === -1 ? null : `byte ${wrong} reads back ${back[wrong]}, ${block[wrong]} was written`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A write that left ESCs holding blocks not known to be good. The session leaves them unstarted. */
export class EscsNotRestored extends Error {
  constructor(
    readonly escs: number[],
    message: string,
  ) {
    super(message);
  }
}

/**
 * Writes `values` (raw, by AM32 field name) to every ESC and returns what each holds after.
 *
 * Every ESC is read and every new block worked out before the first write, so a name or value one
 * ESC's layout refuses stops the write with none of them changed. Each write is read back. One that
 * does not verify stops the write there: its ESC gets its original block back, verified, and the
 * error says so - or, when that fails too, is an EscsNotRestored naming it.
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
    const esc = settings.esc;
    const failed = await writeVerified(fourway, esc, address, next);
    if (failed !== null) {
      const already = out.filter((e, i) => e.block !== planned[i].settings.block).map((e) => e.esc);
      const others = already.length > 0 ? ` ESC ${already.join(", ")} took the new values.` : "";
      const notRestored = await writeVerified(fourway, esc, address, settings.block);
      if (notRestored === null) {
        throw new Error(
          `ESC ${esc} did not take its new settings (${failed}); its original settings are back ` +
            `and verified.${others}`,
        );
      }
      throw new EscsNotRestored(
        [esc],
        `ESC ${esc} did not take its new settings (${failed}), and putting its original settings ` +
          `back failed too (${notRestored}). It is left in its bootloader rather than started on ` +
          "settings that may be damaged. Before unplugging the battery, Read ESCs and write the " +
          "settings again; if that fails, write them with am32.ca through Reboot > ESC " +
          `Passthrough.${others}`,
      );
    }
    log(`ESC ${esc} written and verified.`);
    out.push({ esc, layout: settings.layout, block: next });
  }
  return out;
}

/**
 * Runs `work` inside an ESC passthrough session, and always ends it: every ESC connected is
 * restarted into its app - except any an EscsNotRestored names - the port is closed, and the blaster
 * is waited for in normal mode. An error from `work` wins over one from the cleanup, which is still
 * logged.
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
  const held = failure instanceof EscsNotRestored ? failure.escs : [];
  const steps = [...fourway.connected]
    .filter((esc) => !held.includes(esc))
    .map((esc) => () => fourway.reset(esc));
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
