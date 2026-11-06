import json
import os
import time
from pathlib import Path
import re

from playwright.sync_api import expect

from test_console import connect, go, open_console, serve  # noqa: F401

PROBE = """
window.__long = [];
window.__gaps = [];
window.__vis = [];
document.addEventListener('visibilitychange', () => window.__vis.push([Math.round(performance.now()), document.visibilityState]));
new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({entryTypes: ['longtask']});
(() => {
  const w = new Worker(URL.createObjectURL(new Blob(["onmessage = (e) => setTimeout(() => postMessage(0), e.data);"], {type: 'text/javascript'})));
  let last = performance.now();
  w.onmessage = () => { const now = performance.now(); if (now - last > 130) window.__gaps.push([Math.round(last), Math.round(now - last)]); last = now; w.postMessage(100); };
  w.postMessage(100);
})();
"""


def test_probe(page, serve):  # noqa: F811
    served = serve(device={"useRpmLogging": True, "rpmLogLength": 1200},
                   profiles={1: {"schemaVersion": 2, "dwellTime_ms": 0}})
    for wheel in (1, 3):
        served.bench("wheel", index=wheel, startDelaySpread=0.025)
    page.add_init_script(PROBE)
    connect(open_console(page, served))
    served.wait_armed()
    go(page, "Tune")
    page.get_by_label("PID kp values").fill("0.02, 0.2, 1")
    page.get_by_label("PID ki values").fill("1")
    page.get_by_label("Spin-ups per finalist").fill("2")
    page.get_by_label("Overshoot limit %").fill("1")
    page.get_by_label("Pause below V a cell").fill("3")
    page.get_by_role("button", name="Start", exact=True).click()
    page.get_by_text(re.compile(r"^Done\.|The console let go")).first.wait_for(timeout=120_000)
    data = page.evaluate("({long: window.__long, gaps: window.__gaps, vis: window.__vis, "
                         "hidden: document.visibilityState, focus: document.hasFocus(), "
                         "note: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent)})")
    out = Path(__file__).parent.parent / f"probe-{os.getpid()}-{time.time():.0f}.json"
    out.write_text(json.dumps(data))
    print("\nPROBE", json.dumps(data))
