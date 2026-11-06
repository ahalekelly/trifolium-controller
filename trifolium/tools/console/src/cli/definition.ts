// A tune CLI run definition: the Tune tab's draft as JSON - see tools/console/README.md.

import { DEFAULT_DRAFT, type TuneDraft } from "../tune/draft";

/** The run definition: a Tune tab draft, any part left out taking the tab's default. */
export function draftFrom(json: unknown): TuneDraft {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("The run definition is a JSON object.");
  }
  const def = json as Record<string, unknown>;
  for (const key of Object.keys(def)) {
    if (!(key in DEFAULT_DRAFT)) {
      throw new Error(`The run definition has no "${key}": it takes ${Object.keys(DEFAULT_DRAFT).join(", ")}.`);
    }
  }
  const oneOf = (key: string, allowed: unknown[]) => {
    if (key in def && !allowed.includes(def[key])) {
      throw new Error(`"${key}" is one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}.`);
    }
  };
  oneOf("kind", ["esc", "gains"]);
  oneOf("mode", ["pid", "tbh", "both"]);
  oneOf("oneAtATime", [true, false]);
  const strings = (what: string, value: unknown, known: string[] | null) => {
    if (typeof value !== "object" || value === null) throw new Error(`"${what}" is an object.`);
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) {
      if (known && !known.includes(key)) {
        throw new Error(`"${what}" has no "${key}": it takes ${known.join(", ")}.`);
      }
      if (typeof v !== "string" && typeof v !== "number") {
        throw new Error(`"${what}.${key}" is text, as typed in the Tune tab.`);
      }
      out[key] = String(v);
    }
    return out;
  };
  const draft: TuneDraft = { ...DEFAULT_DRAFT, ...(def as Partial<TuneDraft>) };
  if (def.form !== undefined) {
    draft.form = { ...DEFAULT_DRAFT.form, ...strings("form", def.form, Object.keys(DEFAULT_DRAFT.form)) };
  }
  if (def.esc !== undefined) draft.esc = strings("esc", def.esc, null);
  return draft;
}
