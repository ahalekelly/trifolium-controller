// Candidates scored by repeated trials, every one on exactly n of them.
//
// A trial is one "set": a candidate's spin-up at every target RPM. This module knows nothing of
// what a candidate changes - flywheel gains or ESC settings - only each set's score. A candidate
// ranks on its second-worst set, which for the default n = 20 is the 95th percentile: the spin-up a
// user can count on. One that shares the baseline's settings gets every baseline set too, so may
// have more than n; each is judged on its first n.

/** An ESC that lost sync at speed - see run.ts's desyncOf(). */
export interface Desync {
  /** 1-based, as the console numbers motors. */
  motor: number;
  /** When the first fall began, from the rev's start. */
  atMs: number;
  /** The lowest the motor fell to after reaching speed, over the rest of the rev. */
  minRpm: number;
}

/**
 * One set's outcome. A timed-out set never got every wheel to speed at some RPM, or lost sync at
 * one after.
 */
export interface SetScore {
  timedOut: boolean;
  /** Spin-up time summed over the set's RPMs, a timed-out spin-up at the rampup timeout. */
  ms: number;
  /** The worst motor's overshoot past target at any of its RPMs, % of target. */
  overshootPct: number;
  /** The set's first, which rules its candidate out. */
  desync: Desync | null;
}

/** A set that timed out sorts behind every one that did not. */
const msOf = (s: SetScore) => (s.timedOut ? Infinity : s.ms);

/** The 95th percentile of n = 20: the second-worst. The worst with fewer than two, NaN with none. */
const secondWorst = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, sorted.length - 2)] ?? NaN;
};

/**
 * A candidate's standing: losing sync at speed in any set, or overshoot past the limit where there
 * is one, rules it out, then timeouts and time rank it.
 */
export interface Standing {
  timeouts: number;
  overshootPct: number;
  ms: number;
  /** Its first, in the order its sets ran. */
  desync: Desync | null;
  overshoots: boolean;
  qualified: boolean;
  sets: number;
}

/** On the second-worst set. */
export function standing(scores: SetScore[], limitPct: number | null): Standing {
  const overshootPct = secondWorst(scores.map((s) => s.overshootPct));
  const desync = scores.find((s) => s.desync !== null)?.desync ?? null;
  const overshoots = limitPct !== null && overshootPct > limitPct;
  return {
    timeouts: scores.filter((s) => s.timedOut).length,
    overshootPct,
    ms: secondWorst(scores.map(msOf)),
    desync,
    overshoots,
    qualified: desync === null && !overshoots,
    sets: scores.length,
  };
}

const compareStandings = (a: Standing, b: Standing): number =>
  Number(b.qualified) - Number(a.qualified) ||
  Number(a.desync !== null) - Number(b.desync !== null) ||
  a.timeouts - b.timeouts ||
  a.ms - b.ms;

/**
 * The candidate to run a set of next; null once every one has n, or lost sync in a set, which
 * spares the motors more of it. `stay` goes again while short of n, so a run whose candidates are
 * costly to switch between runs each one's sets as one block. Otherwise the one with the fewest
 * goes, so candidates run in turn and drift over the run spreads across all of them.
 */
export function nextCandidate(
  ids: string[],
  scores: Record<string, SetScore[]>,
  n: number,
  stay: string | null,
): string | null {
  const count = (id: string) => {
    const done = scores[id] ?? [];
    return done.some((s) => s.desync !== null) ? n : done.length;
  };
  if (stay !== null && count(stay) < n) return stay;
  const counts = ids.map(count);
  const fewest = Math.min(...counts);
  return fewest < n ? ids[counts.indexOf(fewest)] : null;
}

/** Every candidate, best first, on its first n sets. */
export function ranking(
  ids: string[],
  scores: Record<string, SetScore[]>,
  n: number,
  limitPct: number | null,
): { id: string; standing: Standing }[] {
  return ids
    .map((id) => ({ id, standing: standing((scores[id] ?? []).slice(0, n), limitPct) }))
    .sort((a, b) => compareStandings(a.standing, b.standing));
}
