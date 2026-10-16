import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

// The menu's ESC Dashboard and per-motor actions, over serial. One row per motor the device
// attached this boot, from DUMP_MOTORS polled while the panel is on screen. The device refuses an
// action it cannot run and says why.

type Direction = "normal" | "reversed";

/** One motor of a DUMP_MOTORS reply. EDT values are null until that ESC sends one. */
interface MotorStatus {
  enabled: boolean;
  targetRPM: number;
  motorRPM: number;
  edt: { v: number | null; i: number | null; t: number | null };
}

export interface MotorsDump {
  motors: MotorStatus[];
  /** flywheelState_t's ordinal. */
  flywheelState: number;
  menuOpen: boolean;
  /** The effective fire mode's id - "safe" while the safety switch is held, too. */
  burstMode: string;
  /** False while SAFE, the menu or the battery rule out a rev. */
  revAllowed: boolean;
}

/** DUMP_MOTORS' motorRPM and EDT values, in column order. */
const TELEMETRY_UNITS = ["RPM", "V", "A", "°C"];

export function MotorActions({
  motors,
  disabled,
  onTest,
  onDirection,
}: {
  /** Null until the first DUMP_MOTORS reply. */
  motors: MotorStatus[] | null;
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
              <TableCell sx={cellSx} />
              {TELEMETRY_UNITS.map((unit) => (
                <TableCell key={unit} align="right" sx={cellSx}>
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {unit}
                  </Typography>
                </TableCell>
              ))}
              <TableCell sx={cellSx} />
              <TableCell sx={cellSx}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  ESC direction
                </Typography>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {motors?.map(
              (status, motor) =>
                status.enabled && (
                  <TableRow key={motor}>
                    <TableCell sx={{ ...cellSx, whiteSpace: "nowrap" }}>
                      <Typography variant="caption" color="text.secondary">
                        Motor {motor + 1}
                      </Typography>
                    </TableCell>
                    {[status.motorRPM, status.edt.v, status.edt.i, status.edt.t].map((value, i) => (
                      <TableCell
                        key={TELEMETRY_UNITS[i]}
                        align="right"
                        sx={{ ...cellSx, minWidth: 40 }}
                      >
                        <Typography
                          variant="caption"
                          color={value === null ? "text.disabled" : undefined}
                        >
                          {value ?? "—"}
                        </Typography>
                      </TableCell>
                    ))}
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
                ),
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
