// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_CONFIG, startRun, type Run } from "../tune/run";
import { Results } from "./Tune";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** A run of one candidate whose sets reached speed in these ms, null for a timeout at 500 ms. */
function runOf(readyMs: (number | null)[]): Run {
  const config = { ...DEFAULT_CONFIG, mode: "pid" as const, kp: [0.2], ki: [1] };
  const run = startRun(config, { control: "pid", kp: 0.2, ki: 0.5 }, 500);
  run.sets = readyMs.map((ms, at) => ({
    id: "PID kp 0.2 ki 1",
    at,
    spinups: [{ rpm: 30000, file: "", readyMs: ms, overshootPct: 0.5, packMv: 16000 }],
  }));
  return run;
}

const cells = () =>
  [...host.querySelectorAll("tbody tr:first-child td")].map((td) => td.textContent);

it("shows the mean, the slowest and the second slowest set", () => {
  act(() => root.render(<Results run={runOf([100, 300, 200, 110])} />));
  expect(cells().slice(2)).toEqual(["0", "178 ms", "300 ms", "200 ms", "0.5%", "4"]);
});

it("shows the slowest as a timeout once any set timed out, counted at the timeout in the mean", () => {
  act(() => root.render(<Results run={runOf([100, null, 200])} />));
  expect(cells().slice(2)).toEqual(["1", "267 ms", "timeout", "200 ms", "0.5%", "3"]);
});
