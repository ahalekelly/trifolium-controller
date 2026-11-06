// Every flywheel ESC's AM32 settings as one row per field, side by side, whichever layout each ESC
// reads with, so ESCs on different firmware still line up.

import { shown, type EscField } from "./layouts";
import type { EscSettings } from "./session";

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
