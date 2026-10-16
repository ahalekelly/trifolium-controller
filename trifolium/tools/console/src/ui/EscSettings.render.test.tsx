// @vitest-environment jsdom

// The ESCs tab against two ESCs read from the configurator's default block: one row per field,
// disagreement flagged, and edits typed as shown turned into the raw values a write takes.

import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LAYOUTS } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import { V4_DEFAULT } from "../esc/testdata";
import { EscSettingsPanel, editedValues, escRows } from "./EscSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Two v4 ESCs, the second with its timing advance changed. */
const twoEscs = (): EscSettings[] => {
  const other = V4_DEFAULT.slice();
  other[23] = 30;
  return [
    { esc: 0, layout: LAYOUTS[4], block: V4_DEFAULT },
    { esc: 1, layout: LAYOUTS[4], block: other },
  ];
};

describe("escRows", () => {
  it("flags the fields ESCs disagree on, and only those", () => {
    const rows = escRows(twoEscs());
    expect(rows.filter((r) => r.disagree).map((r) => r.field.name)).toEqual(["advance_level"]);
    expect(rows.find((r) => r.field.name === "advance_level")!.raws).toEqual([26, 30]);
  });

  it("lines a v3 ESC up with a v4 one, without the field v3 lacks", () => {
    const [a, b] = twoEscs();
    const rows = escRows([a, { ...b, layout: LAYOUTS[3] }]);
    expect(rows.find((r) => r.field.name === "brake_on_zero_throttle")!.raws).toEqual([
      V4_DEFAULT[13],
      null,
    ]);
  });
});

describe("editedValues", () => {
  const rows = escRows(twoEscs());

  it("turns what was typed, as shown, into raw values", () => {
    const { values, errors } = editedValues(rows, {
      motor_kv: "3220",
      advance_level: "15",
      max_ramp: "2.5",
      variable_pwm: "by rpm",
    });
    expect(errors).toEqual({});
    expect(values).toEqual({ motor_kv: 80, advance_level: 26, max_ramp: 25, variable_pwm: 2 });
  });

  it("takes Off where a field has one", () => {
    expect(editedValues(rows, { "limits.current": "off", motor_kv: "Off" }).values).toEqual({
      "limits.current": 0,
      motor_kv: 0,
    });
    expect(editedValues(rows, { startup_power: "off" }).errors).toEqual({
      startup_power: "50 % to 150 %",
    });
  });

  it("says the range of a value out of it, or not a number", () => {
    const { values, errors } = editedValues(rows, { startup_power: "200", motor_poles: "x" });
    expect(values).toEqual({});
    expect(errors).toEqual({ startup_power: "50 % to 150 %", motor_poles: "2 to 36" });
  });
});

describe("EscSettingsPanel", () => {
  it("shows each motor's values and marks where they differ", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <EscSettingsPanel
          escs={twoEscs()}
          motors={[2, 4]}
          disabled={false}
          onRead={() => {}}
          onWrite={() => {}}
        />,
      ),
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Motor 2");
    expect(text).toContain("Motor 4");
    expect(text).toContain("2.21 (4)");
    expect(text).toContain("ESCs differ");
    const write = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Write"));
    expect(write?.disabled).toBe(true); // nothing typed yet
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("EscSettingsPanel's staged edits", () => {
  /** Types into the edit box of the row labelled `label`, as React sees a keystroke. */
  const type = (host: HTMLElement, label: string, text: string) => {
    const row = [...host.querySelectorAll("tr")].find((r) =>
      r.firstElementChild?.textContent?.startsWith(label),
    )!;
    const input = row.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const writeButton = (host: HTMLElement) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Write"))!;

  it("are dropped with the settings they were typed against", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (escs: EscSettings[] | null) =>
      act(async () =>
        root.render(
          <EscSettingsPanel
            escs={escs}
            motors={[2, 4]}
            disabled={false}
            onRead={() => {}}
            onWrite={() => {}}
          />,
        ),
      );
    await render(twoEscs());
    await act(async () => type(host, "Startup power", "120"));
    expect(writeButton(host).textContent).toContain("Write 1 change");

    // A failed write clears the table; the edit must go with it rather than outlive its row.
    await render(null);
    expect(writeButton(host).disabled).toBe(true);
    await render(twoEscs());
    expect(writeButton(host).textContent).not.toContain("1 change");

    await act(async () => root.unmount());
    host.remove();
  });
});
