import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { getByKey } from "../schema/keyPath";

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
  const cellSx = { py: 0.35, px: 0.75, borderBottom: "none" } as const;

  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary">
        Test spins a motor for two seconds. Normal and Reversed set its ESC&rsquo;s direction, then
        spin it to check.
      </Typography>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ width: "auto" }}>
          <TableHead>
            <TableRow>
              <TableCell sx={cellSx} colSpan={2} />
              <TableCell sx={cellSx}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  ESC direction
                </Typography>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {enabledMotors(device).map((motor) => (
              <TableRow key={motor}>
                <TableCell sx={{ ...cellSx, whiteSpace: "nowrap" }}>
                  <Typography variant="caption" color="text.secondary">
                    Motor {motor + 1}
                  </Typography>
                </TableCell>
                <TableCell sx={cellSx}>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={disabled}
                    onClick={() => onTest(motor)}
                  >
                    Test
                  </Button>
                </TableCell>
                <TableCell sx={cellSx}>
                  <Stack direction="row" spacing={1}>
                    {(["normal", "reversed"] as const).map((direction) => (
                      <Button
                        key={direction}
                        size="small"
                        variant="outlined"
                        disabled={disabled}
                        onClick={() => onDirection(motor, direction)}
                      >
                        {direction === "normal" ? "Normal" : "Reversed"}
                      </Button>
                    ))}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
