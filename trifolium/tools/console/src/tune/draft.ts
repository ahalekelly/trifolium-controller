// The Tune form's model: a run as typed - the Tune tab's fields, or a tune CLI run definition - and
// the config it makes.

import { accepted, parseShown, shown, type EscField } from "../esc/layouts";
import { escRows, type EscRow } from "../esc/rows";
import type { EscSettings } from "../esc/session";
import { asBound, boundsToReal } from "../schema/grid";
import { nodeFor, type Schema } from "../schema/types";
import {
  DEFAULT_CONFIG,
  DEFAULT_GAINS,
  type EscGrid,
  type EscValues,
  type GainsGrid,
  type TuneConfig,
} from "./run";

/** The most the firmware takes for a PID or TBH gain, from its schema. */
export function gainMaxOf(schema: Schema): { kp: number; ki: number } {
  const max = (key: string) => {
    const node = nodeFor(schema, key);
    return node?.hi === undefined ? NaN : boundsToReal(asBound(node.hi), node.decimals);
  };
  return { kp: max("device:motorConfig[0].kp"), ki: max("device:motorConfig[0].ki") };
}

/** The form's text for a config, and back. */
export type Form = Record<"kp" | "ki" | "tbh" | "rpms" | "n" | "overshootLimitPct" | "cellV", string>;

/** The search form as typed, kept by App so it outlasts a visit to another page. */
export interface TuneDraft {
  kind: TuneConfig["grid"]["kind"];
  mode: GainsGrid["mode"];
  /** An ESC grid's: one setting changed at a time, or every combination. */
  oneAtATime: boolean;
  form: Form;
  /** Each ESC setting's values to try, as typed, by AM32 field name. */
  esc: Record<string, string>;
}

export const DEFAULT_DRAFT: TuneDraft = {
  kind: "gains",
  mode: DEFAULT_GAINS.mode,
  oneAtATime: false,
  form: {
    kp: DEFAULT_GAINS.kp.join(", "),
    ki: DEFAULT_GAINS.ki.join(", "),
    tbh: DEFAULT_GAINS.tbh.join(", "),
    rpms: DEFAULT_CONFIG.rpms.join(", "),
    n: String(DEFAULT_CONFIG.n),
    overshootLimitPct: String(DEFAULT_GAINS.overshootLimitPct),
    cellV: String(DEFAULT_CONFIG.pauseCellMv / 1000),
  },
  esc: {},
};

/** The settings an ESC run can vary: the searchable ones every ESC has. */
export const searchableRows = (escs: EscSettings[]): EscRow[] =>
  escRows(escs).filter((r) => r.field.searchable && r.raws.every((raw) => raw !== null));

/** What a field's values to try take: what parseShown() does, and the field's `instead`. */
export const takes = (field: EscField) =>
  accepted(field) + (field.instead ? `, or ${field.instead.label}` : "");

/**
 * A value typed to try for `field`, as the writes it makes, or what is wrong with it. A value
 * another field's `instead` makes is that field's to try.
 */
function searchValue(field: EscField, text: string, rows: EscRow[]): EscValues | string {
  if (field.instead && text.trim().toLowerCase() === field.instead.label.toLowerCase()) {
    return field.instead.writes;
  }
  const raw = parseShown(field, text);
  if (raw === null) return `${field.label} takes ${takes(field)}.`;
  const owner = rows.find((r) => r.field.instead?.writes[field.name] === raw)?.field;
  if (owner) {
    const as = `${owner.label} ${owner.instead!.label}`;
    return `${field.label} ${shown(field, raw)} is tried as ${as}.`;
  }
  return { [field.name]: raw };
}

/** Comma- or space-separated numbers, or null if any is not one. */
const listOf = (text: string): number[] | null => {
  const items = text.split(/[\s,]+/).filter(Boolean).map(Number);
  return items.length && items.every(Number.isFinite) ? items : null;
};

/** The grid the form describes, or what is wrong with it. */
function gridOf(
  { kind, mode, oneAtATime, form, esc }: TuneDraft,
  gainMax: { kp: number; ki: number },
  rows: EscRow[],
): TuneConfig["grid"] | string {
  if (kind === "esc") {
    const fields: EscGrid["fields"] = [];
    for (const { field } of rows) {
      const typed = (esc[field.name] ?? "").split(",").filter((t) => t.trim());
      if (typed.length === 0) continue;
      const values: EscValues[] = [];
      for (const text of typed) {
        const value = searchValue(field, text, rows);
        if (typeof value === "string") return value;
        if (!values.some((v) => JSON.stringify(v) === JSON.stringify(value))) values.push(value);
      }
      fields.push({ field, values });
    }
    if (fields.length === 0) return "List values to try for at least one setting.";
    return { kind, fields, oneAtATime };
  }
  const [kp, ki, tbh] = [form.kp, form.ki, form.tbh].map(listOf);
  const within = (values: number[] | null, max: number) =>
    values !== null && values.every((v) => v >= 0 && v <= max);
  if (mode !== "tbh" && !(within(kp, gainMax.kp) && within(ki, gainMax.ki))) {
    return `PID gains are numbers from 0: kp up to ${gainMax.kp}, ki up to ${gainMax.ki}.`;
  }
  if (mode !== "pid" && !within(tbh, gainMax.ki)) {
    return `TBH gains are numbers from 0 to ${gainMax.ki}.`;
  }
  const overshootLimitPct = Number(form.overshootLimitPct);
  if (!(overshootLimitPct >= 0)) return "The overshoot limit is a percentage.";
  return { kind, mode, kp: kp ?? [], ki: ki ?? [], tbh: tbh ?? [], overshootLimitPct };
}

/** The config the form describes, or what is wrong with it. */
export function configOf(
  draft: TuneDraft,
  gainMax: { kp: number; ki: number },
  rows: EscRow[],
): TuneConfig | string {
  const grid = gridOf(draft, gainMax, rows);
  if (typeof grid === "string") return grid;
  const { form } = draft;
  const rpms = listOf(form.rpms);
  const [n, cellV] = [form.n, form.cellV].map(Number);
  if (!rpms || !rpms.every((r) => Number.isInteger(r) && r > 0)) {
    return "Target RPMs are whole numbers.";
  }
  if (!Number.isInteger(n) || n < 2) return "Spin-ups per candidate is a whole number, at least 2.";
  if (!(cellV > 0)) return "The cell voltage to pause at is in volts.";
  return { grid, rpms, n, pauseCellMv: Math.round(cellV * 1000) };
}
