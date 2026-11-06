import { describe, expect, it } from "vitest";
import {
  plan,
  ranking,
  roundTargets,
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
function runSearch(
  ids: string[],
  n: number,
  limitPct: number | null,
  trial: (id: string) => SetScore,
  blocks = false,
  halving = true,
) {
  let search: Search = startSearch(ids, n, halving);
  const scores: Record<string, SetScore[]> = {};
  let last: string | null = null;
  for (;;) {
    const step = plan(search, scores, limitPct, blocks ? last : null);
    last = step.next;
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
    expect(roundTargets(32, 20, true)).toEqual([3, 3, 5, 10, 20]);
    expect(roundTargets(4, 20, true)).toEqual([10, 20]);
    expect(roundTargets(4, 3, true)).toEqual([3, 3]);
    expect(roundTargets(2, 20, true)).toEqual([20]);
    expect(roundTargets(1, 20, true)).toEqual([20]);
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

  it("without halving, gives every candidate n sets as one block and ranks them all", () => {
    expect(roundTargets(32, 20, false)).toEqual([20]);
    const order: string[] = [];
    const ms: Record<string, number> = { a: 300, b: 100, c: 200 };
    const trial = (id: string) => {
      order.push(id);
      return set(ms[id]);
    };
    const { search, scores } = runSearch(Object.keys(ms), 4, 3, trial, true, false);
    expect(order).toEqual(["a", "a", "a", "a", "b", "b", "b", "b", "c", "c", "c", "c"]);
    expect(search.dropped).toEqual({});
    expect(ranking(search, scores, 3).map((r) => [r.id, r.droppedIn])).toEqual([
      ["b", null],
      ["c", null],
      ["a", null],
    ]);
  });

  it("judges a candidate with more sets than a round asks for on its first ones", () => {
    // "s" comes with five sets, its last two slow: it is asked for none, and the first round's
    // three keep it in.
    const scores: Record<string, SetScore[]> = {
      s: [set(100), set(100), set(100), set(900), set(900)],
    };
    let search = startSearch(["s", "a", "b", "c"], 4, true);
    for (;;) {
      const step = plan(search, scores, null, null);
      search = step.search;
      if (step.next === null || search.round > 0) break;
      expect(step.next).not.toBe("s");
      const ms = { a: 200, b: 300, c: 400 }[step.next as "a" | "b" | "c"];
      (scores[step.next] ??= []).push(set(ms));
    }
    expect(search.alive).toEqual(["s", "a"]);
    expect(ranking(search, scores, null)[0].standing.sets).toBe(4);
  });

  it("runs each candidate's sets for a round as one block when told to stay", () => {
    const order: string[] = [];
    const ms: Record<string, number> = { a: 100, b: 300, c: 400, d: 200 };
    runSearch(Object.keys(ms), 4, 3, (id) => {
      order.push(id);
      return set(ms[id]);
    }, true);
    // Rounds end on 3 and 4 sets. d ends the first and is in the second, so it goes on first.
    const blocks = order.filter((id, i) => id !== order[i - 1]);
    expect(blocks).toEqual(["a", "b", "c", "d", "a"]);
    expect(order).toHaveLength(4 * 3 + 2 * 1);
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
    // Rounds end on 3, 5, 10 and 20 sets.
    expect(spent).toBe(16 * 3 + 8 * 2 + 4 * 5 + 2 * 10);
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

  it("without a limit, ranks on fewest timeouts, then time, however far one overshoots", () => {
    const outcome: Record<string, SetScore> = {
      quick: set(150, 5),
      steady: set(200, 1),
      stalls: set(120, 0, true),
      slow: set(260, 1),
    };
    const { search, scores } = runSearch(Object.keys(outcome), 3, null, (id) => outcome[id]);
    expect(search.alive).toEqual(["quick", "steady"]);
    const order = ranking(search, scores, null).map((r) => r.id);
    expect(order).toEqual(["quick", "steady", "slow", "stalls"]);
  });
});
