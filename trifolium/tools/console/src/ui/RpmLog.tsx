import React from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import {
  extractRpmCsv,
  findTrailingFlatStart,
  MS_PER_SAMPLE,
  parseRpmCsv,
  targetCrossings,
  wholeRows,
} from "../rpm/parse";
import { getByKey } from "../schema/keyPath";
import type { Capture } from "../serial/transport";
import { walk, type Schema, type SchemaNode } from "../schema/types";
import { DropLabel, dropOutlineSx, useFileDrop } from "./FileDrop";
import { Field } from "./Field";
import { Fieldset } from "./Section";
import { RpmChart, type Series } from "./RpmChart";

// Charting an RPM capture.
//
// Not a live feature: the firmware records a fixed-length capture into RAM during a rev and dumps the
// whole thing as CSV afterwards. So this charts whichever CSV is to hand - the newest capture the
// blaster sent, a pasted block, or a dropped file - rather than streaming.
//
// `useRpmLogging` is the only switch a capture needs. RpmLogger::sendIfFull writes the CSV to
// Serial directly rather than through the logger, precisely so that the capture a user asked for
// cannot be silenced by a logging preference - only the "dump complete" line after it is gated.
//
// `printTelemetry` is therefore not part of a capture at all, which is why its switch lives in the
// header's button cluster rather than here: it is the device's warn/info switch, armed and cleared
// rather than persisted, because those calls sit in the 1 kHz control loop.

/** Shared by the picker and the drop zone. A capture is plain text under any of these names. */
const CSV_ACCEPT = [".csv", ".txt", ".log", "text/plain"] as const;

const COLOURS = ["#4f9dff", "#ff9f40", "#4ad991", "#e57bd8"];
// What a motor was told (target, throttle) in its colour at half strength; what it did at full.
const faded = (colour: string) => `${colour}80`;

/** Trim ends when a capture's tail is flat for this many samples, within this fractional jitter. */
const MIN_FLAT_RUN = 200;
const FLAT_JITTER = 0.02;

/** The two capture settings, in the order you use them: arm it, then say how long for. */
const CAPTURE_KEYS = ["device:useRpmLogging", "device:rpmLogLength"];

/** Saves a capture as rpm-capture-<local date and time to the second>.csv. */
export function downloadCsv(csv: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const url = URL.createObjectURL(new Blob([`${csv}\n`], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `rpm-capture-${date}_${time}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface RpmLogProps {
  schema: Schema;
  device: unknown;
  onEdit: (key: string, value: unknown) => void;
  /** The newest capture this session. Each new one replaces whatever the box holds. */
  capture: Capture | null;
  /** Whether each finished capture downloads as a CSV file. */
  autoSave: boolean;
  onAutoSave: (on: boolean) => void;
  /** device:useRpmLogging - whether the next rev records a capture at all. */
  capturing: boolean;
  /** Rev and Fire, held from the browser to run a capture. */
  switches: React.ReactNode;
}

export function RpmLog({
  schema,
  device,
  onEdit,
  capture,
  autoSave,
  onAutoSave,
  capturing,
  switches,
}: RpmLogProps) {
  // The box is what you read, edit and save.
  const [text, setText] = React.useState(capture?.csv ?? "");
  const [trim, setTrim] = React.useState(true);
  const [showThrottle, setShowThrottle] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Read out of the schema rather than rebuilt here, so `rpmLogLength` keeps the ceiling the
  // firmware publishes (MAX_RPM_LOG_LENGTH) and both rows keep their reboot marks and dirty
  // outlines. Absent on firmware predating them, which leaves Rev and Fire alone in the box.
  const captureNodes = React.useMemo(() => {
    const found = new Map<string, SchemaNode>();
    walk(schema.tree, (node) => {
      if (node.key && CAPTURE_KEYS.includes(node.key) && !found.has(node.key)) {
        found.set(node.key, node);
      }
    });
    return CAPTURE_KEYS.map((k) => found.get(k)).filter((n): n is SchemaNode => n !== undefined);
  }, [schema]);

  // The box shows the capture as it arrived; the chart and the saved CSV take only its whole rows.
  const whole = React.useMemo(() => {
    const csv = text.trim() ? extractRpmCsv(text) : null;
    return csv ? wholeRows(csv) : null;
  }, [text]);
  const parsed = React.useMemo(() => (whole ? parseRpmCsv(whole.csv) : null), [whole]);

  // Trim against the first motor's RPM: every column is sampled on the same tick, so one series
  // decides the cut for both charts and their x-axes stay aligned.
  const cut = React.useMemo(() => {
    if (!parsed?.motors.length) return 0;
    return trim
      ? findTrailingFlatStart(parsed.motors[0].rpm, MIN_FLAT_RUN, FLAT_JITTER)
      : parsed.motors[0].rpm.length;
  }, [parsed, trim]);

  const series: Series[] = React.useMemo(() => {
    if (!parsed?.motors.length) return [];
    const out: Series[] = [];
    parsed.motors.forEach((m, i) => {
      const colour = COLOURS[i % COLOURS.length];
      out.push({ name: `M${m.index} rpm`, colour, values: m.rpm.slice(0, cut) });
      out.push({
        name: `M${m.index} target`,
        colour: faded(colour),
        values: m.targetRpm.slice(0, cut),
      });
    });
    if (parsed.voltage.length) {
      out.push({
        name: "pack mV",
        colour: "#9aa0a6",
        values: parsed.voltage.slice(0, cut),
        axis: "right",
      });
    }
    return out;
  }, [parsed, cut]);

  // What drives the wheels, under the speed it buys: throttle on the left, the current-sense pin's
  // mV on the right.
  const driveSeries: Series[] = React.useMemo(() => {
    if (!parsed?.motors.length) return [];
    const out: Series[] = [];
    if (showThrottle) {
      parsed.motors.forEach((m, i) => {
        out.push({
          name: `M${m.index} throttle`,
          colour: faded(COLOURS[i % COLOURS.length]),
          values: m.throttle.slice(0, cut),
        });
      });
    }
    if (parsed.current.length) {
      out.push({
        name: "current-sense mV",
        colour: "#9aa0a6",
        values: parsed.current.slice(0, cut),
        // On the left when alone, else the chart draws an empty left axis.
        axis: showThrottle ? "right" : "left",
      });
    }
    return out;
  }, [parsed, cut, showThrottle]);

  // Read off the samples rather than the picture: the differences worth seeing between motors are
  // tens of milliseconds, which is where the lines on the chart overlap.
  const crossings = React.useMemo(() => (parsed ? targetCrossings(parsed) : []), [parsed]);

  // A capture that finishes while the tab is open replaces the box, a loaded file or an edit
  // included.
  React.useEffect(() => {
    if (!capture) return;
    setText(capture.csv);
    setError(null);
  }, [capture]);

  /** Picked or dropped, a file lands in the box the same way. */
  const readFile = async (file: File) => {
    setError(null);
    setText(await file.text());
  };

  const { over, dropProps } = useFileDrop({
    accept: CSV_ACCEPT,
    what: "a .csv, .txt or .log capture",
    onFile: (file) => void readFile(file),
    onReject: setError,
  });

  // The chart, the table and the CSV are all derived from the box, so emptying it clears the tab.
  const clear = () => {
    setText("");
    setError(null);
  };

  /** The CSV as it would be saved: the whole rows extracted, not the raw box contents. */
  const csvOut = whole?.csv ?? null;

  return (
    <Stack spacing={1} {...dropProps} sx={dropOutlineSx(over)}>
      <DropLabel over={over} label="Drop a .csv capture here" />
      {/*
        The two settings that decide whether there is anything to chart, on the tab that charts it.
        They used to sit under Device > RPM Capture, two tabs from the button that reads the result,
        which meant arming a capture and looking at one were different places. DEVICE_LAYOUT claims
        both keys as RENDERED_ELSEWHERE so they do not also fall through into "Other settings".
      */}
      {/* Rev and Fire beside them, so arming a capture and running one is a single flow. */}
      <Fieldset label="Capture">
        <Stack spacing={1}>
          <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            {captureNodes.map((node) => (
              <Box key={node.key} sx={{ minWidth: 150 }}>
                <Field
                  node={node}
                  value={getByKey(device, node.key!)}
                  onChange={(next) => onEdit(node.key!, next)}
                />
              </Box>
            ))}
          </Stack>
          {switches}
        </Stack>
      </Fieldset>

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Button size="small" variant="outlined" onClick={() => fileRef.current?.click()}>
          Open CSV file
        </Button>
        <Button size="small" variant="outlined" onClick={clear} disabled={!text && !error}>
          Clear
        </Button>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={autoSave}
              onChange={(e) => {
                onAutoSave(e.target.checked);
                // Turning it on saves what is already shown; later captures save as they arrive.
                if (e.target.checked && csvOut) downloadCsv(csvOut);
              }}
            />
          }
          disableTypography
          label={<Typography variant="caption">Save CSV files</Typography>}
          sx={{ m: 0, gap: 0.5 }}
        />
        <input
          ref={fileRef}
          type="file"
          accept={CSV_ACCEPT.join(",")}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void readFile(file);
          }}
        />
        <FormControlLabel
          control={
            <Checkbox size="small" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
          }
          disableTypography
          label={<Typography variant="caption">Trim flat tail</Typography>}
          sx={{ m: 0, gap: 0.5 }}
        />
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={showThrottle}
              onChange={(e) => setShowThrottle(e.target.checked)}
            />
          }
          disableTypography
          label={<Typography variant="caption">Throttle</Typography>}
          sx={{ m: 0, gap: 0.5 }}
        />
        {parsed && (
          <Typography variant="caption" color="text.secondary">
            {parsed.motors.length} motor{parsed.motors.length === 1 ? "" : "s"},{" "}
            {parsed.motors[0]?.rpm.length ?? 0} samples
            {series.length && series[0].values.length !== parsed.motors[0]?.rpm.length
              ? ` (charting ${series[0].values.length})`
              : ""}
          </Typography>
        )}
      </Stack>

      {!text && (
        <Typography variant="caption" color="text.secondary">
          {capturing
            ? "Rev the blaster to capture."
            : "Turn on RPM Logging to capture."}
        </Typography>
      )}

      {error && (
        <Alert severity="info" sx={{ py: 0 }}>
          {error}
        </Alert>
      )}

      {whole && whole.dropped > 0 && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {whole.dropped} {whole.dropped === 1 ? "row" : "rows"} of this capture arrived damaged
          and {whole.dropped === 1 ? "is" : "are"} left out of the chart and the saved CSV.
        </Alert>
      )}

      {series.length > 0 ? (
        <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1 }}>
          <RpmChart series={series} />
          {driveSeries.length > 0 && <RpmChart series={driveSeries} height={180} />}
          {crossings.length > 0 && (
            <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
                First time at target
              </Typography>
              <Table size="small" sx={{ width: "auto" }}>
                <TableHead>
                  <TableRow>
                    {["Motor", "Target", "Time", "Overshoot"].map((h) => (
                      <TableCell key={h} sx={{ py: 0.25, px: 1, borderBottom: "none" }}>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                          {h}
                        </Typography>
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {crossings.map((c) => (
                    <TableRow key={c.motor}>
                      <TableCell sx={{ py: 0.25, px: 1, borderBottom: "none" }}>
                        <Typography variant="caption">M{c.motor}</Typography>
                      </TableCell>
                      <TableCell sx={{ py: 0.25, px: 1, borderBottom: "none" }}>
                        <Typography variant="caption" color="text.secondary">
                          {c.target === null ? "not driven" : `${c.target} rpm`}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ py: 0.25, px: 1, borderBottom: "none" }}>
                        <Typography
                          variant="caption"
                          color={c.sample === null ? "warning.main" : "text.primary"}
                        >
                          {c.sample === null
                            ? c.target === null
                              ? "\u2014"
                              : "never, in this capture"
                            : `${c.sample * MS_PER_SAMPLE} ms`}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ py: 0.25, px: 1, borderBottom: "none" }}>
                        <Typography variant="caption" color="text.secondary">
                          {c.overshoot === null
                            ? "\u2014"
                            : `${c.overshoot > 0 ? "+" : ""}${Math.round(c.overshoot)} rpm`}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 0.5 }}>
                Measured from the first sample of the capture, which begins when the rev does - one
                sample is one tick of the 1 kHz control loop, so one millisecond. Overshoot is the
                highest RPM reached while driven, less the target.
              </Typography>
            </Box>
          )}
        </Box>
      ) : (
        text.trim() && (
          <Alert severity="warning" sx={{ py: 0 }}>
            No CSV capture found in that text. The header looks like
            <code> Voltage_mv,Motor 1,TargetRPM 1,Throttle 1,value 1,</code>
          </Alert>
        )
      )}

      <TextField
        multiline
        minRows={4}
        maxRows={10}
        size="small"
        placeholder="Paste a capture here, drop a .csv file anywhere on this tab, or open one above."
        value={text}
        onChange={(e) => setText(e.target.value)}
        slotProps={{ htmlInput: { style: { fontSize: 11, fontFamily: "ui-monospace, monospace" } } }}
      />
    </Stack>
  );
}
