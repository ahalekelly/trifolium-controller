// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { POLL_MS, RevHold, type MotorsStatus, type RevHoldApi } from "./RevHold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The v1.2: motors 2 and 4 enabled. */
const READY: MotorsStatus = {
  menuOpen: false,
  burstMode: "auto",
  motors: [{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: true }],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function api(status: MotorsStatus | null = READY) {
  const release = vi.fn<() => void>();
  return {
    hold: vi.fn<(mask: number, onLost: () => void) => () => void>(() => release),
    release,
    status: vi.fn(async () => status),
  } satisfies RevHoldApi & { release: unknown };
}

async function mount(a: RevHoldApi, live = true) {
  await act(async () => root.render(<RevHold api={a} live={live} tuning={false} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const button = () => [...host.querySelectorAll("button")].find((b) => /rev/i.test(b.textContent!))!;
const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });

describe("RevHold", () => {
  it("holds while the button is down, and releases when it comes up", async () => {
    const a = api();
    await mount(a);
    fire(button(), "pointerdown");
    expect(a.hold).toHaveBeenCalledTimes(1);
    expect(a.hold).toHaveBeenLastCalledWith(0b1010, expect.any(Function));
    fire(button(), "pointerup");
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("lets the button up when the blaster refuses the rev", async () => {
    const a = api();
    await mount(a);
    fire(button(), "pointerdown");
    act(() => a.hold.mock.calls[0][1]());
    expect(button().textContent).toBe("Hold to rev");
    fire(button(), "pointerup");
    expect(a.release).not.toHaveBeenCalled();
  });

  it.each([
    ["moving off the button", (el: Element) => fire(el, "pointerout", { relatedTarget: document.body })],
    ["the window losing focus", () => act(() => void window.dispatchEvent(new Event("blur")))],
  ])("lets go on %s", async (_, leave) => {
    const a = api();
    await mount(a);
    fire(button(), "pointerdown");
    leave(button());
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("lets go when the tab is hidden", async () => {
    const a = api();
    await mount(a);
    fire(button(), "pointerdown");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("revs only the motors left ticked", async () => {
    const a = api();
    await mount(a);
    const [motor2] = host.querySelectorAll("input[type=checkbox]");
    fire(motor2, "click");
    fire(button(), "pointerdown");
    expect(a.hold).toHaveBeenLastCalledWith(0b1000, expect.any(Function));
  });

  it.each([
    ["the menu is open", { ...READY, menuOpen: true }, /menu is open/],
    ["the blaster is in SAFE", { ...READY, burstMode: "safe" }, /in SAFE/],
  ])("is disabled while %s", async (_, status, says) => {
    const a = api(status);
    await mount(a);
    expect(button().disabled).toBe(true);
    expect(host.textContent).toMatch(says);
    fire(button(), "pointerdown");
    expect(a.hold).not.toHaveBeenCalled();
  });

  it("asks the blaster again while nothing is held, so a menu closed later re-enables it", async () => {
    const a = api({ ...READY, menuOpen: true });
    await mount(a);
    a.status.mockResolvedValue(READY);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(button().disabled).toBe(false);
  });

  it("lets go when the blaster disconnects", async () => {
    const a = api();
    await mount(a);
    fire(button(), "pointerdown");
    await mount(a, false);
    expect(a.release).toHaveBeenCalledTimes(1);
  });
});
