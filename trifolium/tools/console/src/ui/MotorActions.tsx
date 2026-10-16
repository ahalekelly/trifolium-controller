import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { getByKey } from "../schema/keyPath";
import { Para } from "./Help";

// The menu's per-motor actions, run over serial. Offered for the motors this config enables; the
// device refuses one it did not attach this boot, and while the flywheels are running.

type Direction = "normal" | "reversed";

/** 0-based indices of the motors this config enables. */
function enabledMotors(device: unknown): number[] {
  return [0, 1, 2, 3].filter((i) => getByKey(device, `device:motorConfig[${i}].enabled`) === true);
}

export function MotorActions({
  device,
  disabled,
  onTest,
  onDirection,
}: {
  device: unknown;
  disabled: boolean;
  onTest: (motor: number) => void;
  onDirection: (motor: number, direction: Direction) => void;
}) {
  return (
    <Stack spacing={0.5}>
      <Para>
        Test spins a motor for two seconds at low throttle. Normal and Reversed write the direction
        stored in the ESC, then spin it: the spin is how you check which way it turns.
      </Para>
      {enabledMotors(device).map((motor) => (
        <Stack key={motor} direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="body2" sx={{ minWidth: 64 }}>
            Motor {motor + 1}
          </Typography>
          <Button size="small" variant="outlined" disabled={disabled} onClick={() => onTest(motor)}>
            Test
          </Button>
          <Typography variant="body2" color="text.secondary" sx={{ pl: 1 }}>
            Set ESC direction:
          </Typography>
          {(["normal", "reversed"] as const).map((direction) => (
            <Button
              key={direction}
              size="small"
              disabled={disabled}
              onClick={() => onDirection(motor, direction)}
              sx={{ textTransform: "none" }}
            >
              {direction === "normal" ? "Normal" : "Reversed"}
            </Button>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
