import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT } from "../tune/draft";
import { draftFrom } from "./definition";

describe("a run definition", () => {
  it("is a Tune tab draft, what it leaves out the tab's defaults, numbers taken as typed", () => {
    const draft = draftFrom({
      kind: "esc",
      oneAtATime: true,
      form: { rpms: "30000", n: 20 },
      esc: { advance_level: "15, 22.5", startup_power: 120 },
    });
    expect(draft).toEqual({
      ...DEFAULT_DRAFT,
      kind: "esc",
      oneAtATime: true,
      form: { ...DEFAULT_DRAFT.form, rpms: "30000", n: "20" },
      esc: { advance_level: "15, 22.5", startup_power: "120" },
    });
  });

  it("names what it does not know", () => {
    expect(() => draftFrom({ sets: 20 })).toThrow('The run definition has no "sets"');
    expect(() => draftFrom({ form: { spinups: "20" } })).toThrow('"form" has no "spinups"');
    expect(() => draftFrom({ esc: { advance_level: ["15"] } })).toThrow('"esc.advance_level" is text');
    expect(() => draftFrom([])).toThrow("is a JSON object");
    expect(() => draftFrom({ kind: "ESC" })).toThrow('"kind" is one of "esc", "gains"');
    expect(() => draftFrom({ oneAtATime: "false" })).toThrow('"oneAtATime" is one of true, false');
  });
});
