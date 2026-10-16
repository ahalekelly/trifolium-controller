// A sleep that keeps time in a hidden tab.
//
// Chrome slows a background page's own timers to once a second, and chains of them to once a
// minute, but leaves a dedicated worker's alone. A held switch renews every 100 ms, and a tuning run
// does that for hours with its tab out of sight, so those waits are timed in a worker.

const WORKER = "onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);";

let worker: Worker | null = null;
const waiting = new Map<number, () => void>();
let nextId = 0;

export function sleep(ms: number): Promise<void> {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
    worker.onmessage = (e: MessageEvent<number>) => {
      waiting.get(e.data)!();
      waiting.delete(e.data);
    };
  }
  const id = nextId++;
  const woken = new Promise<void>((resolve) => waiting.set(id, resolve));
  worker.postMessage({ id, ms });
  return woken;
}
