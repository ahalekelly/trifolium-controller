import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import * as React from "react";
import type { SchemaNode } from "../schema/types";
import type { MatrixExtra } from "./Section";

// The Motors menu's two actions, as rows of the motor table: spin one motor to see it turn, and set
// its ESC's direction then spin it to check. Below them, the ESC Dashboard's live readings. The direction is written to the ESC, not read from it -
// AM32 has no way to report it - so the spin is the answer to which way it turns, and Normal and
// Reversed are two buttons rather than a toggle that would have to know the current state.

/** A command's ack, or null when none came. */
export type Ack = { ok: boolean; err?: string } | null;

/** The parts of DUMP_MOTORS the live rows show. An `edt` reading is null until that ESC sends one. */
export interface MotorsLive {
  motors: { motorRPM: number; edt?: { v: number | null; i: number | null; t: number | null } }[];
}

/** The menu's ESC Dashboard redraws at 10 Hz; twice a second is plenty for a page. */
export const MOTORS_LIVE_POLL_MS = 500;

/** About as long as the blaster takes: a 2 s spin, plus the ESC write for a direction. */
const SPIN_MS = 2500;

/** One action at a time across every motor: the blaster refuses a second while one runs. */
export function useMotorActions(
  run: (command: string) => Promise<Ack>,
  onResult: (ok: boolean, text: string) => void,
) {
  const [busy, setBusy] = React.useState(false);
  const act = async (command: string, what: string) => {
    setBusy(true);
    const ack = await run(command);
    if (ack?.ok) onResult(true, `${what}.`);
    else onResult(false, `${what} refused: ${ack?.err ?? "no reply"}.`);
    // The ack comes as the spin starts; another press before it ends would be refused anyway.
    if (ack?.ok) await new Promise((r) => setTimeout(r, SPIN_MS));
    setBusy(false);
  };
  return { busy, act };
}

/** The motor a matrix column stands for, read off its fields' keys. */
export function motorIndexOf(group: SchemaNode): number | null {
  for (const child of group.children ?? []) {
    const m = /motorConfig\[(\d+)\]/.exec(child.key ?? "");
    if (m) return Number(m[1]);
  }
  return null;
}

export interface MotorActionRowsOptions {
  /** Indices of the motors the wiring enables. */
  motors: number[];
  /** Connected, to firmware that has the commands. */
  available: boolean;
  /** The latest DUMP_MOTORS, or null when there is none. */
  live: MotorsLive | null;
  busy: boolean;
  act: (command: string, what: string) => Promise<void>;
}

const NEEDS = "Needs a connected blaster on firmware 2.3.0 or later, at rest with its menu closed.";

const reading = (value: number | null | undefined, digits: number, unit: string) =>
  `${value === null || value === undefined ? "-" : value.toFixed(digits)} ${unit}`;

export function motorActionRows({
  motors,
  available,
  live,
  busy,
  act,
}: MotorActionRowsOptions): MatrixExtra[] {
  const motorOf = (g: SchemaNode) => {
    const i = motorIndexOf(g);
    return i !== null && motors.includes(i) ? i : null;
  };
  const sx = { minWidth: 0, px: 1, fontSize: 12 } as const;
  const liveSx = { fontSize: 12, fontVariantNumeric: "tabular-nums", whiteSpace: "pre" } as const;
  return [
    {
      label: "Test",
      help: `Spins this motor alone for about 2 s. ${NEEDS}`,
      cell: (g) => {
        const i = motorOf(g);
        if (i === null) return null;
        return (
          <Button
            size="small"
            variant="outlined"
            sx={sx}
            disabled={!available || busy}
            aria-label={`Test motor ${i + 1}`}
            onClick={() => void act(`MOTOR_TEST ${i}`, `Motor ${i + 1} spun`)}
          >
            Test
          </Button>
        );
      },
    },
    {
      label: "Direction",
      help: `Writes that direction to this motor's ESC, then spins it to check. ${NEEDS}`,
      cell: (g) => {
        const i = motorOf(g);
        if (i === null) return null;
        return (
          <Stack direction="row" spacing={0.5}>
            <Button
              size="small"
              variant="outlined"
              sx={sx}
              disabled={!available || busy}
              aria-label={`Set motor ${i + 1} to Normal`}
              onClick={() => void act(`MOTOR_NORMAL ${i}`, `Motor ${i + 1} set to Normal`)}
            >
              Normal
            </Button>
            <Button
              size="small"
              variant="outlined"
              sx={sx}
              disabled={!available || busy}
              aria-label={`Set motor ${i + 1} to Reversed`}
              onClick={() => void act(`MOTOR_REVERSED ${i}`, `Motor ${i + 1} set to Reversed`)}
            >
              Reversed
            </Button>
          </Stack>
        );
      },
    },
    {
      label: "RPM",
      help: "What this motor's ESC reports, live while this page is open.",
      cell: (g) => {
        const i = motorOf(g);
        return i === null || !live ? null : <Box sx={liveSx}>{live.motors[i]?.motorRPM}</Box>;
      },
    },
    {
      label: "ESC",
      help: "The ESC's own voltage, current and temperature, from its extended telemetry. A dash is a reading it has not sent.",
      cell: (g) => {
        const i = motorOf(g);
        if (i === null || !live) return null;
        const edt = live.motors[i]?.edt;
        return (
          <Box sx={liveSx}>
            {`${reading(edt?.v, 1, "V")}  ${reading(edt?.i, 0, "A")}  ${reading(edt?.t, 0, "°C")}`}
          </Box>
        );
      },
    },
  ];
}
