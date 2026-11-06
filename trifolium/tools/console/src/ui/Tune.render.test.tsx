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
  startRun,
  type Run,
  type SetRecord,
} from "../tune/run";
import { TuneRunner } from "../tune/runner";
import { atRank, DEFAULT_DRAFT, Results, SpinupTraces, Tune } from "./Tune";

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
        { rpm: 30000, file: "", readyMs: ms, reachMs: ms, overshootPct: 0.5, packMv: 16000, trace: [{ rpm: [0, 1, 2], full: [] }] },
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
    expect(cells().slice(3)).toEqual(["0", "178 ms", "200 ms", "300 ms", "0.5%", "4"]);
  });

  it("orders its columns, the 2nd slowest before the slowest", () => {
    act(() => root.render(results(runOf([100]))));
    const heads = [...host.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual([
      "Chart",
      "Candidate",
      "",
      "Timeouts",
      "Mean",
      "2nd slowest",
      "Slowest",
      "2nd worst overshoot",
      "Sets",
    ]);
  });

  it("shows an ESC run's full matrix without overshoot, standings or a best", () => {
    const field = LAYOUTS[4].fields.find((f) => f.name === "startup_power")!;
    const values = [80, 120].map((startup_power) => ({ startup_power }));
    const grid = { kind: "esc" as const, fields: [{ field, values }] };
    const run = startRun(
      { ...DEFAULT_CONFIG, grid, n: 2, halving: false },
      { gains: { control: "pid", kp: 0.2, ki: 0.5 }, esc: { startup_power: 100 } },
      null,
      null,
      500,
    );
    const spinup = { rpm: 30000, file: "", readyMs: 100, reachMs: 100, overshootPct: 9, packMv: 16000, trace: [] };
    run.sets = ["Startup power 80 %", "Startup power 120 %"].map((id) => ({
      id,
      at: 0,
      spinups: [spinup],
    }));
    run.status = "done";
    act(() => root.render(results(run)));
    const heads = [...host.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual([
      "Chart",
      "Candidate",
      "Timeouts",
      "Mean to 80%",
      "2nd slowest to 80%",
      "Slowest to 80%",
      "Sets",
    ]);
    expect(host.textContent).not.toMatch(/best|finalist|9\.0%/);
  });

  it("shows the slowest as a timeout once any set timed out, counted at the timeout in the mean", () => {
    act(() => root.render(results(runOf([100, null, 200]))));
    expect(cells().slice(3)).toEqual(["1", "267 ms", "200 ms", "timeout", "0.5%", "3"]);
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

  const chart = (sets: SetRecord[], checked: string[]) => (
    <SpinupTraces
      sets={sets}
      rpms={[30000]}
      candidates={["a", "b"]}
      checked={checked}
      same={null}
      grid={DEFAULT_GAINS}
    />
  );

  /** A set of one spin-up, each motor's RPM in `rpms`, all at full throttle. */
  const set = (id: string, rpms: number[][]): SetRecord => ({
    id,
    at: 0,
    spinups: [
      {
        rpm: 30000,
        file: "",
        readyMs: 100,
        reachMs: 100,
        overshootPct: 0,
        packMv: 16000,
        trace: rpms.map((rpm) => ({ rpm, full: [[0, rpm.length]] })),
      },
    ],
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

  it("shows the candidate with the baseline's settings and the baseline as one row", () => {
    const run = startRun(
      { ...DEFAULT_CONFIG, grid: { ...DEFAULT_GAINS, kp: [0.2, 0.4], ki: [0.5] } },
      { gains: { control: "pid", kp: 0.2, ki: 0.5 }, esc: null },
      null,
      null,
      500,
    );
    run.sets = [set(BASELINE, [[0]]), set("PID kp 0.4 ki 0.5", [[0]])];
    act(() => root.render(<Results run={run} checked={[]} onCheck={() => {}} />));
    const rows = [...host.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r!.startsWith("PID kp 0.2 ki 0.5"))).toMatch(
      /^PID kp 0\.2 ki 0\.5 \(starting settings\).*1$/,
    );
    expect(rows.some((r) => r!.includes("Baseline"))).toBe(false);
  });

  it("overlays every motor of every spin-up of each checked row, a colour per row", () => {
    const sets = [
      set("a", [[0, 100, 200], [0, 90, 180]]),
      set("b", [[0, 50, 100], [0, 40, 80]]),
      set("a", [[0, 120, 240], [0, 80, 160]]),
    ];
    act(() => root.render(chart(sets, ["a", "b"])));
    const paths = [...host.querySelectorAll("path[stroke]:not([stroke-dasharray])")];
    // One path a row, a line in it a motor a spin-up.
    expect(paths.map((p) => p.getAttribute("d")!.split("M").length - 1)).toEqual([4, 2]);
    expect(new Set(paths.map((p) => p.getAttribute("stroke"))).size).toBe(2);
    expect(host.textContent).toContain("All spin-ups at 30000 RPM");
  });

  it("colours a row by its place in the grid, whatever order rows were checked in", () => {
    const sets = [set("a", [[0, 1]]), set("b", [[0, 1]])];
    const strokes = () =>
      Object.fromEntries(
        [...host.querySelectorAll("path[stroke]:not([stroke-dasharray])")].map((p, i) => [i, p.getAttribute("stroke")]),
      );
    act(() => root.render(chart(sets, ["a", "b"])));
    const [a, b] = Object.values(strokes());
    act(() => root.render(chart(sets, ["b", "a"])));
    expect(Object.values(strokes())).toEqual([b, a]);
    act(() => root.render(chart(sets, ["b"])));
    expect(Object.values(strokes())).toEqual([b]);
  });

  it("draws one spin-up a row at the rank chosen, timeouts slowest and the lower median", () => {
    const at = (readyMs: number | null, rpm = 1): SetRecord => ({
      id: "a",
      at: 0,
      spinups: [
        {
          rpm: 30000,
          file: "",
          readyMs,
          reachMs: readyMs,
          overshootPct: 0,
          packMv: 0,
          trace: [{ rpm: [0, rpm], full: [[0, 2]] }],
        },
      ],
    });
    const sets = [at(300, 3), at(null, 9), at(100, 1), at(200, 2)];
    const spinups = sets.map((s) => s.spinups[0]);
    expect(atRank(spinups, "median", (s) => s.readyMs).readyMs).toBe(200);
    expect(atRank(spinups, "secondSlowest", (s) => s.readyMs).readyMs).toBe(300);
    expect(atRank(spinups, "slowest", (s) => s.readyMs).readyMs).toBeNull();

    act(() => root.render(chart(sets, ["a"])));
    act(() => {
      host.querySelector("[role=combobox]")!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    const option = [...document.querySelectorAll("[role=option]")].find(
      (o) => o.textContent === "2nd slowest",
    ) as HTMLElement;
    act(() => option.click());
    expect(host.querySelectorAll("path[stroke]:not([stroke-dasharray])")[0].getAttribute("d")!.split("M")).toHaveLength(2);
    expect(host.textContent).toContain("a (300 ms)");
    expect(host.textContent).toContain("2nd slowest at 30000 RPM");
  });

  it("draws a line solid at full throttle and dashed where the controller backed off", () => {
    const backsOff: SetRecord = set("a", [[0, 10, 20, 30]]);
    backsOff.spinups[0].trace[0].full = [[0, 2]];
    act(() => root.render(chart([backsOff], ["a"])));
    const points = (selector: string) =>
      host.querySelector(selector)!.getAttribute("d")!.trim().split(" ").length / 2;
    // Solid over samples 0 and 1; dashed from 1, where the two meet, to 3.
    expect(points("path[stroke]:not([stroke-dasharray])")).toBe(2);
    expect(points("path[stroke-dasharray]")).toBe(3);
  });

  it("ranks an ESC run's spin-ups by their time to 80% of target", () => {
    const field = LAYOUTS[4].fields.find((f) => f.name === "startup_power")!;
    const grid = { kind: "esc" as const, fields: [{ field, values: [{ startup_power: 80 }] }] };
    const sets = [100, 200, 300].map((reachMs, i) => {
      const s = set("a", [[0, i]]);
      s.spinups[0] = { ...s.spinups[0], readyMs: 400 - reachMs, reachMs };
      return s;
    });
    const traces = (
      <SpinupTraces sets={sets} rpms={[30000]} candidates={["a"]} checked={["a"]} same={null} grid={grid} />
    );
    act(() => root.render(traces));
    act(() => {
      host.querySelector("[role=combobox]")!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    const option = [...document.querySelectorAll("[role=option]")].find(
      (o) => o.textContent === "Slowest",
    ) as HTMLElement;
    act(() => option.click());
    expect(host.textContent).toContain("a (300 ms)");
  });

  it("asks for a row to chart when none is checked", () => {
    act(() => root.render(chart([], [])));
    expect(host.textContent).toContain("Check rows to chart their spin-ups.");
  });
});

describe("the Apply button", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The finished run page's Apply button, for a run saved as `applied`. */
  async function applyButton(applied: boolean) {
    const grid = { ...DEFAULT_GAINS, kp: [0.4], ki: [1] };
    const run = startRun(
      { ...DEFAULT_CONFIG, grid },
      { gains: { control: "pid", kp: 0.2, ki: 0.5 }, esc: null },
      null,
      null,
      500,
    );
    const spinup = { rpm: 30000, file: "", readyMs: 100, reachMs: 100, overshootPct: 0, packMv: 16000, trace: [] };
    run.sets = [{ id: "PID kp 0.4 ki 1", at: 0, spinups: [spinup] }];
    Object.assign(run, { status: "done", applied });
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(run) });
    const host = document.createElement("div");
    const root = createRoot(host);
    const unused = () => Promise.reject(new Error("not in this test"));
    const transport = { connected: true, chipId: null } as unknown as SerialTransport;
    await act(async () =>
      root.render(
        <Tune
          runner={new TuneRunner(transport, { read: unused, write: unused }, unused)}
          live
          device={DEVICE}
          gainMax={{ kp: 2, ki: 2 }}
          escs={null}
          draft={DEFAULT_DRAFT}
          onDraft={() => {}}
          onApply={() => {}}
        />,
      ),
    );
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent!.endsWith("PID kp 0.4 ki 1"),
    )!;
    const state = { text: button.textContent, disabled: button.disabled };
    await act(async () => root.unmount());
    return state;
  }

  it("is greyed out as Applied once the run's winner is applied, and only then", async () => {
    expect(await applyButton(false)).toEqual({ text: "Apply PID kp 0.4 ki 1", disabled: false });
    expect(await applyButton(true)).toEqual({ text: "Applied PID kp 0.4 ki 1", disabled: true });
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
    expect(text).not.toContain("Overshoot limit");
    // Rounds end on 10 and 20 spin-ups: 4 x 10, then 2 finalists x 10 more. A write opens each
    // candidate's block, and each baseline block but the first.
    expect(text).toContain("4 candidates, about 60 spin-ups and about 8 ESC writes");
  });

  it("plans every candidate's N spin-ups without halving", async () => {
    const grid = { startup_power: "80, 120", motor_kv: "off, 3220" };
    const text = await formText(escsWith(V4_DEFAULT[25]), grid, false);
    expect(text).toContain("4 candidates, about 80 spin-ups and about 6 ESC writes");
    expect(text).toContain("Spin-ups per candidate");
    expect(text).toContain("Every candidate gets N spin-ups.");
  });

  it("says what a setting takes, and shows where the ESCs differ", async () => {
    expect(await formText(escsWith(V4_DEFAULT[25]), { startup_power: "80, 200" })).toContain(
      "Startup power takes 50 % to 150 %.",
    );
    expect(await formText(escsWith(120), { startup_power: "80" })).toMatch(/Startup powerdiffer/);
  });

  it("takes By RPM as a PWM frequency to try, and not as a PWM type", async () => {
    const escs = escsWith(V4_DEFAULT[25]);
    expect(await formText(escs, { pwm_frequency: "32, 48, by rpm" })).toContain("3 candidates");
    expect(await formText(escs, { pwm_frequency: "fast" })).toContain(
      "PWM frequency takes 8 kHz to 144 kHz, or By RPM.",
    );
    expect(await formText(escs, { variable_pwm: "Fixed, By RPM" })).toContain(
      "PWM type By RPM is tried as PWM frequency By RPM.",
    );
  });
});
