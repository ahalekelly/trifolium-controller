import { describe, expect, it } from "vitest";
import {
  plan,
  plannedSets,
  ranking,
  roundTargets,
  secondWorst,
  startSearch,
  type Search,
  type SetScore,
} from "./search";

const set = (ms: number, overshootPct = 0, timedOut = false): SetScore => ({
  ms,
  overshootPct,
  timedOut,
});

/** Runs a search to its end against `trial`, the way the runner does, counting sets as it goes. */
function runSearch(ids: string[], n: number, limitPct: number, trial: (id: string) => SetScore) {
  let search: Search = startSearch(ids, n);
  const scores: Record<string, SetScore[]> = {};
  for (;;) {
    const step = plan(search, scores, limitPct);
    search = step.search;
    if (step.next === null) return { search, scores };
    (scores[step.next] ??= []).push(trial(step.next));
  }
}

/** A seeded uniform [0, 1), so a noisy run repeats. */
function random(seed: number) {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

describe("roundTargets", () => {
  it("doubles towards n from a few sets, one round per halving", () => {
    expect(roundTargets(32, 20)).toEqual([3, 3, 5, 10, 20]);
    expect(roundTargets(4, 20)).toEqual([10, 20]);
    expect(roundTargets(4, 3)).toEqual([3, 3]);
    expect(roundTargets(2, 20)).toEqual([20]);
    expect(roundTargets(1, 20)).toEqual([20]);
  });

  it("plans the sets those rounds take", () => {
    // 32 x 3, then 8 more x 2, 4 x 5, 2 x 10.
    expect(plannedSets(32, 20)).toBe(96 + 16 + 20 + 20);
    expect(plannedSets(1, 20)).toBe(20);
  });
});

describe("secondWorst", () => {
  it("is the 95th percentile of 20", () => {
    expect(secondWorst([...Array(20).keys()])).toBe(18);
    expect(secondWorst([5])).toBe(5);
    expect(secondWorst([])).toBeNaN();
  });
});

describe("a search", () => {
  it("runs a round's candidates in turn", () => {
    const order: string[] = [];
    runSearch(["a", "b", "c"], 3, 3, (id) => {
      order.push(id);
      return set(100);
    });
    expect(order.slice(0, 6)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("drops the slower half on noisy spin-ups and gives each finalist exactly n", () => {
    // Each candidate's true spin-up, under +-40 ms of noise - more than separates neighbours.
    const truth: Record<string, number> = {};
    for (let i = 0; i < 16; i++) truth[`c${i}`] = 150 + i * 6;
    const noise = random(7);
    const { search, scores } = runSearch(Object.keys(truth), 20, 3, (id) =>
      set(truth[id] + (noise() - 0.5) * 80),
    );

    expect(Object.keys(search.dropped)).toHaveLength(14);
    expect(search.alive.every((id) => scores[id].length === 20)).toBe(true);
    // Most of the spin-ups went where the decision was close.
    const spent = Object.values(scores).reduce((sum, s) => sum + s.length, 0);
    expect(spent).toBe(plannedSets(16, 20));
    expect(spent).toBeLessThan(16 * 20 / 3);
    // The winner is among the truly fast: noise can swap neighbours, never the field.
    const best = ranking(search, scores, 3)[0].id;
    expect(truth[best]).toBeLessThan(170);
    expect(search.dropped.c15).toBe(0);
  });

  it("rules out overshoot past the limit, then ranks on fewest timeouts, then time", () => {
    const outcome: Record<string, SetScore> = {
      quick: set(150, 5),
      steady: set(200, 1),
      stalls: set(120, 0, true),
      slow: set(260, 1),
    };
    const { search, scores } = runSearch(Object.keys(outcome), 3, 3, (id) => outcome[id]);
    expect(search.alive).toEqual(["steady", "slow"]);
    expect(search.dropped).toEqual({ quick: 0, stalls: 0 });
    const order = ranking(search, scores, 3).map((r) => r.id);
    expect(order).toEqual(["steady", "slow", "stalls", "quick"]);
  });
});
