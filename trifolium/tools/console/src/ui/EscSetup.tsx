import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { getByKey } from "../schema/keyPath";
import { HelpSection, Para, Step, Steps } from "./Help";

// The ESC's half of the motor settings, stated next to the controller's half.
//
// The fields above are what the firmware does with the motors - it divides the ESC's eRPM by
// Poles/2 to get RPM and estimates throttle from Kv, both in flywheelMotor.cpp - while AM32 holds its
// own copy of the same two facts and decides, through its protections, whether a motor is allowed
// to keep turning at all. The two copies have to agree, and the ESC's are set on the ESCs tab. So:
// prose beside the fields, with the numbers it tells you to set read from the fields themselves.

export interface EscMotorSetup {
  /** 1-based, as the motor matrix above labels them. */
  which: number;
  /** The whole pole count AM32 asks for - twice the Poles/2 this device stores. */
  poles: number;
  kv: number;
}

/** Motors sharing one pair of numbers. `which` is 1-based, in matrix order. */
export interface EscSetupGroup {
  which: number[];
  poles: number;
  kv: number;
}

/**
 * Enabled motors' AM32 numbers, read from device settings.
 *
 * Enabled-only, because passthrough hands over the pins of enabled motors and no others - an ESC
 * this console cannot reach is not one to tell somebody to go and configure. A motor missing either
 * number is skipped rather than guessed at: nothing here is worth printing a wrong value for.
 */
export function escSetups(device: unknown): EscMotorSetup[] {
  const out: EscMotorSetup[] = [];
  for (let i = 0; i < 4; i++) {
    if (getByKey(device, `device:motorConfig[${i}].enabled`) !== true) continue;
    const polesDiv2 = Number(getByKey(device, `device:motorConfig[${i}].motorPolesDiv2`));
    const kv = Number(getByKey(device, `device:motorConfig[${i}].motorKv`));
    if (!Number.isFinite(polesDiv2) || !Number.isFinite(kv)) continue;
    out.push({ which: i + 1, poles: polesDiv2 * 2, kv });
  }
  return out;
}

/** Identical motors collapsed into one line, since four the same is the ordinary case. */
export function groupSetups(setups: EscMotorSetup[]): EscSetupGroup[] {
  const groups: EscSetupGroup[] = [];
  for (const setup of setups) {
    const found = groups.find((g) => g.poles === setup.poles && g.kv === setup.kv);
    if (found) found.which.push(setup.which);
    else groups.push({ which: [setup.which], poles: setup.poles, kv: setup.kv });
  }
  return groups;
}

/** "14 poles, 3200 Kv", prefixed by which motors when they do not all agree. */
export function setupLine(group: EscSetupGroup, alone: boolean): string {
  const numbers = `${group.poles} poles, ${group.kv} Kv`;
  if (alone) return numbers;
  const which = group.which.map((n) => `Motor ${n}`).join(", ");
  return `${which}: ${numbers}`;
}

/** What to set on the ESCs, for under the Motors & PID fields. */
export function EscSetup({ device }: { device: unknown }) {
  const groups = groupSetups(escSetups(device));

  return (
    <HelpSection summary="Setting up the ESCs in AM32">
      <Para>
        The flywheel ESCs run AM32, and its settings live on the ESCs rather than in this config.
        The ESCs tab reads them and writes them to every flywheel ESC at once.
      </Para>
      <Para>Two things to set there, then write them:</Para>
      <Steps>
        <Step>
          Turn <b>Stuck rotor protection</b> and <b>Stall protection</b> off.
        </Step>
        <Step>
          Set <b>Motor poles</b> and <b>Motor Kv</b> to the motor you actually fitted, matching what
          this page holds. AM32 wants the whole pole count, which is twice the Poles/2 above.
          {groups.length > 0 && (
            <Box component="ul" sx={{ m: 0, mt: 0.35, pl: 2.5 }}>
              {groups.map((group) => (
                <Typography
                  key={group.which.join(",")}
                  component="li"
                  variant="body2"
                  color="text.secondary"
                  sx={{ display: "list-item" }}
                >
                  {setupLine(group, groups.length === 1)}
                </Typography>
              ))}
            </Box>
          )}
        </Step>
      </Steps>
    </HelpSection>
  );
}
