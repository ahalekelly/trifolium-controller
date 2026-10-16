import React from "react";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { firmwareOf, rawFrom, shown, type EscField } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import { Para } from "./Help";

// The ESCs tab: every flywheel ESC's AM32 settings side by side, and one column of edits that a
// write applies to all of them.
//
// A row lists each field once, by AM32's name, whichever layout each ESC reads with, so ESCs on
// different firmware still line up. Where their values differ the row says so - after a write they
// agree on every field it named, but a field nobody wrote keeps whatever each ESC had.

export interface EscRow {
  field: EscField;
  /** Each ESC's raw value, or null where its layout lacks the field. */
  raws: (number | null)[];
  disagree: boolean;
}

/** One row per field any ESC has, in the order the first layout to name it lists it. */
export function escRows(escs: EscSettings[]): EscRow[] {
  const fields: EscField[] = [];
  for (const { layout } of escs) {
    for (const field of layout.fields) {
      if (!fields.some((f) => f.name === field.name)) fields.push(field);
    }
  }
  return fields.map((field) => {
    const raws = escs.map(({ layout, block }) => {
      const own = layout.fields.find((f) => f.name === field.name);
      return own ? block[own.offset] : null;
    });
    // Compared as shown, so two raw values that both mean Off agree.
    const present = raws.filter((r): r is number => r !== null).map((r) => shown(field, r));
    return { field, raws, disagree: new Set(present).size > 1 };
  });
}

/**
 * Typed edits as the raw values a write takes, or why one cannot be written. A number is typed as
 * shown (with its scale and shift) and goes to the nearest raw step, which must be in range; "off"
 * is Off where the field has one.
 */
export function editedValues(
  rows: EscRow[],
  edits: Record<string, string>,
): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const [name, text] of Object.entries(edits)) {
    const field = rows.find((r) => r.field.name === name)!.field;
    if (field.off && text.trim().toLowerCase() === "off") {
      values[name] = field.off.raw;
      continue;
    }
    const raw = field.options ? Number(text) : rawFrom(field, Number(text));
    if (!Number.isInteger(raw) || raw < field.min || raw > field.max) {
      const range = `${shown(field, field.min)} to ${shown(field, field.max)}`;
      errors[name] = field.off ? `${range}, or Off` : range;
    } else {
      values[name] = raw;
    }
  }
  return { values, errors };
}

export function EscSettingsPanel({
  escs,
  motors,
  disabled,
  onRead,
  onWrite,
}: {
  /** Null until the ESCs are first read. */
  escs: EscSettings[] | null;
  /** The motor number of each flywheel ESC, in passthrough order. */
  motors: number[];
  disabled: boolean;
  onRead: () => void;
  onWrite: (values: Record<string, number>) => void;
}) {
  // Edits belong to the settings they were typed against, so a new read, a write's result or a
  // failure that clears the table drops them in the same render rather than one later.
  const [staged, setStaged] = React.useState({ escs, edits: {} as Record<string, string> });
  const edits = staged.escs === escs ? staged.edits : {};
  const setEdits = (next: Record<string, string>) => setStaged({ escs, edits: next });
  const rows = React.useMemo(() => (escs ? escRows(escs) : []), [escs]);
  const { values, errors } = editedValues(rows, edits);
  const editCount = Object.keys(edits).length;
  const valid = editCount > 0 && Object.keys(errors).length === 0;

  const edit = (name: string, text: string | null) => {
    const next = { ...edits };
    if (text === null) delete next[name];
    else next[name] = text;
    setEdits(next);
  };

  return (
    <Stack spacing={1}>
      <Para>
        The AM32 settings on every flywheel ESC, read and written through ESC passthrough. Each read
        or write restarts the blaster and takes several seconds. A write sets the same values on
        every ESC and leaves everything else as it was, motor directions included; the pusher ESC
        is never touched.
      </Para>
      <Stack direction="row" spacing={1}>
        <Button variant="outlined" size="small" disabled={disabled} onClick={onRead}>
          Read ESCs
        </Button>
        <Button
          variant="contained"
          size="small"
          disabled={disabled || !valid}
          onClick={() => onWrite(values)}
        >
          Write {editCount || ""} {editCount === 1 ? "change" : "changes"} to all ESCs
        </Button>
        <Button size="small" disabled={editCount === 0} onClick={() => setEdits({})}>
          Discard
        </Button>
      </Stack>

      {escs && (
        <Table size="small" sx={{ "& td, & th": { py: 0.25 } }}>
          <TableHead>
            <TableRow>
              <TableCell>Setting</TableCell>
              {escs.map(({ esc }) => (
                <TableCell key={esc}>
                  Motor {motors[esc]}
                  {/* The log and its errors name ESCs by passthrough index. */}
                  <Typography component="span" variant="caption" color="text.secondary">
                    {" "}
                    · ESC {esc}
                  </Typography>
                </TableCell>
              ))}
              <TableCell sx={{ width: 180 }}>Write to all</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>Firmware (settings layout)</TableCell>
              {escs.map(({ esc, block, layout }) => (
                <TableCell key={esc}>
                  {firmwareOf(block)} ({layout.version})
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
            {rows.map(({ field, raws, disagree }) => (
              <TableRow key={field.name}>
                <TableCell>
                  {field.label}
                  {field.searchable && (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {" "}
                      · spin-up
                    </Typography>
                  )}
                  {disagree && (
                    <Typography component="span" variant="caption" color="warning.main">
                      {" "}
                      · ESCs differ
                    </Typography>
                  )}
                </TableCell>
                {raws.map((raw, i) => (
                  <TableCell key={i} sx={{ color: disagree ? "warning.main" : undefined }}>
                    {raw === null ? "-" : shown(field, raw)}
                  </TableCell>
                ))}
                <TableCell>
                  <TextField
                    select={field.options !== null}
                    size="small"
                    variant="standard"
                    fullWidth
                    value={edits[field.name] ?? ""}
                    placeholder={field.off ? `${field.unit} or Off`.trim() : field.unit}
                    error={field.name in errors}
                    helperText={errors[field.name]}
                    onChange={(e) => edit(field.name, e.target.value === "" ? null : e.target.value)}
                  >
                    {field.options?.map((label, i) => (
                      <MenuItem key={label} value={String(field.min + i)}>
                        {label}
                      </MenuItem>
                    ))}
                  </TextField>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}
