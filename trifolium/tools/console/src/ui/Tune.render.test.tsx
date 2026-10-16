// @vitest-environment jsdom

// The Tune tab's ESC run form, against two ESCs read from the configurator's default block.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LAYOUTS } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import { V4_DEFAULT } from "../esc/testdata";
import type { SerialTransport } from "../serial/transport";
import { plannedEscWrites } from "../tune/run";
import { TuneRunner } from "../tune/runner";
import { DEFAULT_DRAFT, Tune } from "./Tune";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVICE = {
  useRpmLogging: true,
  rpmLogLength: 1200,
  rampupTimeout_ms: 500,
  batteryType: "4s",
  flywheelControl: "pid",
  motorConfig: [{ enabled: true, kp: 0.2, ki: 0.5 }],
};

const escsWith = (startupPower: number): EscSettings[] => {
  const other = V4_DEFAULT.slice();
  other[25] = startupPower;
  return [
    { esc: 0, layout: LAYOUTS[4], block: V4_DEFAULT },
    { esc: 1, layout: LAYOUTS[4], block: other },
  ];
};

/** The form's text with these ESCs and these values typed for them. */
async function formText(escs: EscSettings[], esc: Record<string, string>) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const unused = () => Promise.reject(new Error("not in this test"));
  await act(async () =>
    root.render(
      <Tune
        runner={new TuneRunner({} as SerialTransport, { read: unused, write: unused })}
        live
        device={DEVICE}
        gainMax={{ kp: 2, ki: 2 }}
        escs={escs}
        draft={{ ...DEFAULT_DRAFT, kind: "esc", esc }}
        onDraft={() => {}}
        onApply={() => {}}
      />,
    ),
  );
  const text = host.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

describe("the ESC run form", () => {
  it("offers the spin-up settings, not the fixed ones, and plans the writes the grid takes", async () => {
    const text = await formText(escsWith(V4_DEFAULT[25]), {
      startup_power: "80, 120",
      motor_kv: "off, 3220",
    });
    expect(text).toContain("Startup power");
    expect(text).toContain("Motor Kv");
    expect(text).not.toContain("Current limit");
    expect(text).not.toContain("Motor poles");
    expect(text).not.toContain("Brake on stop");
    // Rounds end on 10 and 20 spin-ups: 4 x 10, then 2 finalists x 10 more.
    const writes = plannedEscWrites(4, 20);
    expect(text).toContain(`4 candidates, about 60 spin-ups and at most ${writes} ESC writes`);
  });

  it("says what a setting takes, and shows where the ESCs differ", async () => {
    expect(await formText(escsWith(V4_DEFAULT[25]), { startup_power: "80, 200" })).toContain(
      "Startup power takes 50 % to 150 %.",
    );
    expect(await formText(escsWith(120), { startup_power: "80" })).toMatch(/Startup powerdiffer/);
  });
});
