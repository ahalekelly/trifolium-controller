// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LAYOUTS } from "../esc/layouts";
import type { EscSettings } from "../esc/session";
import { V4_DEFAULT } from "../esc/testdata";
import type { SerialTransport } from "../serial/transport";
import {
  BASELINE,
  DEFAULT_CONFIG,
  DEFAULT_GAINS,
  plannedEscWrites,
  startRun,
  type Run,
  type SetRecord,
} from "../tune/run";
import { TuneRunner } from "../tune/runner";
import { DEFAULT_DRAFT, Results, SpinupTraces, Tune } from "./Tune";

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
async function formText(escs: EscSettings[], esc: Record<string, string>, halving = true) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const unused = () => Promise.reject(new Error("not in this test"));
  await act(async () =>
    root.render(
      <Tune
        runner={new TuneRunner({} as SerialTransport, { read: unused, write: unused }, unused)}
        live
        device={DEVICE}
        gainMax={{ kp: 2, ki: 2 }}
        escs={escs}
        draft={{ ...DEFAULT_DRAFT, kind: "esc", esc, halving }}
        onDraft={() => {}}
        onApply={() => {}}
      />,
    ),
  );
  const text = host.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

describe("the results table", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    root = createRoot(host);
  });

  afterEach(() => act(() => root.unmount()));

  /** A run of one candidate whose sets reached speed in these ms, null for a timeout at 500 ms. */
  function runOf(readyMs: (number | null)[]): Run {
    const grid = { ...DEFAULT_GAINS, kp: [0.2], ki: [1] };
    const gains = { control: "pid" as const, kp: 0.2, ki: 0.5 };
    const run = startRun({ ...DEFAULT_CONFIG, grid }, { gains, esc: null }, null, null, 500);
    run.sets = readyMs.map((ms, at) => ({
      id: "PID kp 0.2 ki 1",
      at,
      spinups: [
        { rpm: 30000, file: "", readyMs: ms, overshootPct: 0.5, packMv: 16000, trace: [[0, 1, 2]] },
      ],
    }));
    return run;
  }

  const results = (run: Run, onCheck = () => {}) => (
    <Results run={run} checked={[]} onCheck={onCheck} />
  );

  const cells = () =>
    [...host.querySelectorAll("tbody tr:first-child td")].map((td) => td.textContent);

  it("shows the mean, the slowest and the second slowest set", () => {
    act(() => root.render(results(runOf([100, 300, 200, 110]))));
    expect(cells().slice(3)).toEqual(["0", "178 ms", "300 ms", "200 ms", "0.5%", "4"]);
  });

  it("shows the slowest as a timeout once any set timed out, counted at the timeout in the mean", () => {
    act(() => root.render(results(runOf([100, null, 200]))));
    expect(cells().slice(3)).toEqual(["1", "267 ms", "timeout", "200 ms", "0.5%", "3"]);
  });
});

describe("the spin-up chart", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const set = (id: string, trace: number[][]): SetRecord => ({
    id,
    at: 0,
    spinups: [{ rpm: 30000, file: "", readyMs: 100, overshootPct: 0, packMv: 16000, trace }],
  });

  it("checks a candidate's row and the baseline's to chart them", () => {
    const run = startRun(
      { ...DEFAULT_CONFIG, grid: { ...DEFAULT_GAINS, kp: [0.2], ki: [1] } },
      { gains: { control: "pid", kp: 0.2, ki: 0.5 }, esc: null },
      null,
      null,
      500,
    );
    run.sets = [set(BASELINE, [[0]]), set("PID kp 0.2 ki 1", [[0]])];
    const onCheck = vi.fn();
    act(() => root.render(<Results run={run} checked={[BASELINE]} onCheck={onCheck} />));
    const boxes = host.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((b) => [b.getAttribute("aria-label"), b.checked])).toEqual([
      ["Chart PID kp 0.2 ki 1", false],
      ["Chart the baseline", true],
    ]);
    act(() => boxes[0].click());
    expect(onCheck).toHaveBeenCalledWith([BASELINE, "PID kp 0.2 ki 1"]);
  });

  it("overlays every motor of every spin-up of each checked row, a colour per row", () => {
    const sets = [
      set("a", [[0, 100, 200], [0, 90, 180]]),
      set("b", [[0, 50, 100], [0, 40, 80]]),
      set("a", [[0, 120, 240], [0, 80, 160]]),
    ];
    act(() => root.render(<SpinupTraces sets={sets} rpms={[30000]} checked={["a", "b"]} />));
    const paths = [...host.querySelectorAll("path")];
    // One path a row, a line in it a motor a spin-up.
    expect(paths.map((p) => p.getAttribute("d")!.split("M").length - 1)).toEqual([4, 2]);
    expect(new Set(paths.map((p) => p.getAttribute("stroke"))).size).toBe(2);
    expect(host.textContent).toContain("Every spin-up at 30000 RPM");
  });

  it("asks for a row to chart when none is checked", () => {
    act(() => root.render(<SpinupTraces sets={[]} rpms={[30000]} checked={[]} />));
    expect(host.textContent).toContain("Check rows to chart their spin-ups.");
  });
});

// Against two ESCs read from the configurator's default block.
describe("the ESC run form", () => {
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
  afterEach(() => vi.unstubAllGlobals());

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
    const writes = plannedEscWrites(4, 20, true);
    expect(text).toContain(`4 candidates, about 60 spin-ups and at most ${writes} ESC writes`);
  });

  it("plans every candidate's N spin-ups without halving", async () => {
    const grid = { startup_power: "80, 120", motor_kv: "off, 3220" };
    const text = await formText(escsWith(V4_DEFAULT[25]), grid, false);
    const writes = plannedEscWrites(4, 20, false);
    expect(text).toContain(`4 candidates, about 80 spin-ups and at most ${writes} ESC writes`);
    expect(text).toContain("Spin-ups per candidate");
    expect(text).toContain("Every candidate gets N spin-ups.");
  });

  it("says what a setting takes, and shows where the ESCs differ", async () => {
    expect(await formText(escsWith(V4_DEFAULT[25]), { startup_power: "80, 200" })).toContain(
      "Startup power takes 50 % to 150 %.",
    );
    expect(await formText(escsWith(120), { startup_power: "80" })).toMatch(/Startup powerdiffer/);
  });
});
