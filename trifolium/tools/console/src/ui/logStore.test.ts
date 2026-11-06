import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_LINES, LogStore } from "./logStore";

const line = (text: string) => ({ kind: "in" as const, text, at: 0 });

describe("LogStore", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the newest lines and tells listeners once per burst", () => {
    vi.useFakeTimers();
    const log = new LogStore();
    const listener = vi.fn();
    log.subscribe(listener);
    for (let i = 0; i <= LOG_LINES; i++) log.push(line(String(i)));
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.lines()).toHaveLength(LOG_LINES);
    expect(log.lines()[0].text).toBe("1");
  });

  it("hands out the same lines until the log next changes", () => {
    vi.useFakeTimers();
    const log = new LogStore();
    log.push(line("a"));
    vi.advanceTimersByTime(100);
    const before = log.lines();
    log.push(line("b"));
    expect(log.lines()).toBe(before);
    vi.advanceTimersByTime(100);
    expect(log.lines().map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("tells listeners of a clear at once", () => {
    vi.useFakeTimers();
    const log = new LogStore();
    const listener = vi.fn();
    log.subscribe(listener);
    log.push(line("a"));
    log.clear();
    expect(log.lines()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
