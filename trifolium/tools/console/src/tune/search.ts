// Successive halving over candidates scored by repeated trials.
//
// A trial is one "set": a candidate's spin-up at every target RPM. This module knows nothing of
// what a candidate changes - flywheel gains or ESC settings - only each set's score. Early rounds
// give every surviving candidate a few sets and drop the worse half on medians, which is cheap and
// robust to a stray set; the finalists then get exactly n sets, ranked on the second-worst, which
// for the default n = 20 is the 95th percentile: the spin-up a user can count on.

/** One set's outcome. A timed-out set never got every wheel to speed at some RPM. */
export interface SetScore {
  timedOut: boolean;
  /** Spin-up time summed over the set's RPMs; meaningless when timed out. */
  ms: number;
  /** The worst motor's overshoot past target at any of its RPMs, % of target. */
  overshootPct: number;
}

export interface Search {
  /** How many sets each surviving candidate has by the end of each round; the last is n. */
  rounds: number[];
  round: number;
  /** In the order they were given, which is the order they run in. */
  alive: string[];
  /** The round each dropped candidate left in. */
  dropped: Record<string, number>;
}

/** Halving stops once this few remain; they are the finalists. */
const FINALISTS = 2;
/** The fewest sets a median is taken over. */
const EARLY_SETS = 3;

/**
 * The set counts the rounds end on: each halving round doubles the last, ending at n. The first
 * starts at EARLY_SETS, so a short search may spend no extra sets on its last halving.
 */
export function roundTargets(count: number, n: number): number[] {
  let halvings = 0;
  for (let alive = count; alive > FINALISTS; alive = Math.ceil(alive / 2)) halvings++;
  const targets: number[] = [];
  for (let r = 0; r < halvings; r++) {
    targets.push(Math.min(n, Math.max(EARLY_SETS, Math.ceil(n / 2 ** (halvings - r)))));
  }
  return [...targets, n];
}

export function startSearch(ids: string[], n: number): Search {
  if (ids.length === 0) throw new Error("a search needs at least one candidate");
  if (n < 2) throw new Error("the 95th percentile needs n of at least 2");
  return { rounds: roundTargets(ids.length, n), round: 0, alive: [...ids], dropped: {} };
}

/**
 * How many sets a search of `count` candidates runs, baseline sets aside, and in how many blocks: a
 * block is one candidate's sets for one round.
 */
export function planned(count: number, n: number): { sets: number; blocks: number } {
  let alive = count;
  let done = 0;
  let sets = 0;
  let blocks = 0;
  for (const target of roundTargets(count, n)) {
    if (target > done) {
      sets += alive * (target - done);
      blocks += alive;
    }
    done = target;
    if (alive > FINALISTS) alive = Math.max(FINALISTS, Math.ceil(alive / 2));
  }
  return { sets, blocks };
}

export const finished = (search: Search): boolean => search.round >= search.rounds.length;

/** A set that timed out sorts behind every one that did not. */
const msOf = (s: SetScore) => (s.timedOut ? Infinity : s.ms);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The 95th percentile of n = 20: the second-worst. The worst with fewer than two, NaN with none. */
export const secondWorst = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, sorted.length - 2)] ?? NaN;
};

/** A candidate's standing: overshoot past the limit rules it out, then timeouts and time rank it. */
export interface Standing {
  timeouts: number;
  overshootPct: number;
  ms: number;
  qualified: boolean;
  sets: number;
}

/** On medians, for the early rounds. */
function earlyStanding(scores: SetScore[], limitPct: number): Standing {
  const overshootPct = median(scores.map((s) => s.overshootPct));
  return {
    timeouts: scores.filter((s) => s.timedOut).length / scores.length,
    overshootPct,
    ms: median(scores.map(msOf)),
    qualified: overshootPct <= limitPct,
    sets: scores.length,
  };
}

/** On the second-worst set, for the finalists and the results. */
export function standing(scores: SetScore[], limitPct: number): Standing {
  const overshootPct = secondWorst(scores.map((s) => s.overshootPct));
  return {
    timeouts: scores.filter((s) => s.timedOut).length,
    overshootPct,
    ms: secondWorst(scores.map(msOf)),
    qualified: overshootPct <= limitPct,
    sets: scores.length,
  };
}

export const compareStandings = (a: Standing, b: Standing): number =>
  Number(b.qualified) - Number(a.qualified) || a.timeouts - b.timeouts || a.ms - b.ms;

/**
 * The candidate to run a set of next, closing whichever rounds its candidates have finished; null
 * once the search is over. `stay` goes again while it is still in and short of the round's sets, so
 * a search whose candidates are costly to switch between runs each one's sets for a round as one
 * block - and a candidate that ends one round and is first into the next keeps going. Otherwise the
 * one with the fewest sets goes first, so a round runs its candidates in turn rather than one after
 * another, and drift over the run spreads across all of them.
 */
export function plan(
  search: Search,
  scores: Record<string, SetScore[]>,
  limitPct: number,
  stay: string | null,
): { search: Search; next: string | null } {
  let current = search;
  while (!finished(current)) {
    const target = current.rounds[current.round];
    const counts = current.alive.map((id) => scores[id]?.length ?? 0);
    const stays = stay === null ? -1 : current.alive.indexOf(stay);
    if (stays >= 0 && counts[stays] < target) return { search: current, next: stay };
    const fewest = Math.min(...counts);
    if (fewest < target) return { search: current, next: current.alive[counts.indexOf(fewest)] };
    current = closeRound(current, scores, limitPct);
  }
  return { search: current, next: null };
}

function closeRound(search: Search, scores: Record<string, SetScore[]>, limitPct: number): Search {
  const last = search.round === search.rounds.length - 1;
  if (last || search.alive.length <= FINALISTS) return { ...search, round: search.round + 1 };
  const ranked = [...search.alive].sort((a, b) =>
    compareStandings(earlyStanding(scores[a], limitPct), earlyStanding(scores[b], limitPct)),
  );
  const keep = new Set(ranked.slice(0, Math.max(FINALISTS, Math.ceil(ranked.length / 2))));
  const dropped = { ...search.dropped };
  for (const id of search.alive) if (!keep.has(id)) dropped[id] = search.round;
  return {
    ...search,
    round: search.round + 1,
    alive: search.alive.filter((id) => keep.has(id)),
    dropped,
  };
}

/** Every candidate, best first: the finalists on their n sets, then the rest, last dropped first. */
export function ranking(
  search: Search,
  scores: Record<string, SetScore[]>,
  limitPct: number,
): { id: string; standing: Standing; droppedIn: number | null }[] {
  const row = (id: string) => ({
    id,
    standing: standing(scores[id] ?? [], limitPct),
    droppedIn: search.dropped[id] ?? null,
  });
  const finalists = search.alive.map(row).sort((a, b) => compareStandings(a.standing, b.standing));
  const dropped = Object.keys(search.dropped)
    .map(row)
    .sort(
      (a, b) => b.droppedIn! - a.droppedIn! || compareStandings(a.standing, b.standing),
    );
  return [...finalists, ...dropped];
}
