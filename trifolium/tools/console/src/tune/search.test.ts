import { describe, expect, it } from "vitest";
import { nextCandidate, ranking, type SetScore } from "./search";

const set = (ms: number, overshootPct = 0, timedOut = false): SetScore => ({
  ms,
  overshootPct,
  timedOut,
});

/** Runs every set nextCandidate() asks for against `trial`, returning the ids in order. */
function runAll(ids: string[], n: number, trial: (id: string) => SetScore, blocks = false) {
  const scores: Record<string, SetScore[]> = {};
  const order: string[] = [];
  for (;;) {
    const next = nextCandidate(ids, scores, n, blocks ? (order[order.length - 1] ?? null) : null);
    if (next === null) return { scores, order };
    order.push(next);
    (scores[next] ??= []).push(trial(next));
  }
}

describe("nextCandidate", () => {
  it("runs candidates in turn, n sets each", () => {
    const { order } = runAll(["a", "b", "c"], 2, () => set(100));
    expect(order).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("runs each candidate's sets as one block when told to stay", () => {
    const { order } = runAll(["a", "b", "c"], 2, () => set(100), true);
    expect(order).toEqual(["a", "a", "b", "b", "c", "c"]);
  });

  it("asks nothing of a candidate that already has n", () => {
    const scores = { s: [set(100), set(100)] };
    expect(nextCandidate(["s", "a"], scores, 2, null)).toBe("a");
    expect(nextCandidate(["s"], scores, 2, "s")).toBeNull();
  });
});

describe("ranking", () => {
  const outcome: Record<string, SetScore> = {
    quick: set(150, 5),
    steady: set(200, 1),
    stalls: set(120, 0, true),
    slow: set(260, 1),
  };

  it("rules out overshoot past the limit, then ranks on fewest timeouts, then time", () => {
    const { scores } = runAll(Object.keys(outcome), 3, (id) => outcome[id]);
    const order = ranking(Object.keys(outcome), scores, 3, 3).map((r) => r.id);
    expect(order).toEqual(["steady", "slow", "stalls", "quick"]);
  });

  it("without a limit, ranks on fewest timeouts, then time, however far one overshoots", () => {
    const { scores } = runAll(Object.keys(outcome), 3, (id) => outcome[id]);
    const order = ranking(Object.keys(outcome), scores, 3, null).map((r) => r.id);
    expect(order).toEqual(["quick", "steady", "slow", "stalls"]);
  });

  it("judges a candidate on its first n sets", () => {
    const scores = { s: [set(100), set(100), set(900), set(900)], a: [set(200), set(200)] };
    const rows = ranking(["a", "s"], scores, 2, null);
    expect(rows.map((r) => [r.id, r.standing.sets, r.standing.ms])).toEqual([
      ["s", 2, 100],
      ["a", 2, 200],
    ]);
  });
});
