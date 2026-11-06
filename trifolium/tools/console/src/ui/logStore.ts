import type { LogLine } from "../serial/transport";

/** The device log keeps the newest this many lines. */
export const LOG_LINES = 1000;
/** A flood of lines re-renders the log at most this often. */
const NOTIFY_MS = 100;

/** The device log, outside React state so a line re-renders only the views that show it. */
export class LogStore {
  private buffer: LogLine[] = [];
  /** `buffer` as of the last notify: the same array until the log next changes. */
  private snapshot: LogLine[] = [];
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  push = (line: LogLine) => {
    this.buffer.push(line);
    if (this.buffer.length > LOG_LINES) this.buffer.shift();
    this.timer ??= setTimeout(this.notify, NOTIFY_MS);
  };

  clear = () => {
    this.buffer = [];
    this.notify();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  lines = () => this.snapshot;

  private notify = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.snapshot = this.buffer.slice();
    for (const listener of this.listeners) listener();
  };
}
