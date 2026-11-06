"""The tune CLI (tools/console/src/cli/tune.ts) against a simulated blaster's serial, over TCP.

Gains runs only: the simulator has no AM32 ESCs behind its passthrough, so ESC runs are tested in
the console's own runner tests. Needs `npm ci` in tools/console.
"""

import json
import shutil
import signal
import socket
import subprocess
import sys
import time

import pytest

from helpers import start_server

from trifolium_sim import PROJECT

CONSOLE = PROJECT / "tools" / "console"
NPM = shutil.which("npm")
if NPM is None or not (CONSOLE / "node_modules").is_dir():
    raise pytest.UsageError(f"the tune CLI needs `npm ci` in {CONSOLE}")

GAINS_RUN = {"kind": "gains", "mode": "pid", "form": {"kp": "0.2", "ki": "1", "rpms": "30000", "cellV": "3"}}


class Sim:
    def __init__(self):
        self.proc, self.serial, self.control, _, _ = start_server(
            "--instant-escs", "--preset", "trifolium_v1_2",
            "--device", json.dumps({"useRpmLogging": True, "rpmLogLength": 1200}),
            "--profile", "1=" + json.dumps({"schemaVersion": 2, "dwellTime_ms": 0}))
        deadline = time.monotonic() + 30
        while not self.bench("peek", names=["booted"])["values"]["booted"]:
            assert time.monotonic() < deadline, "the blaster never finished booting"
            time.sleep(0.1)
        until = self.bench("state")["uptime_ms"] + 2500  # ESC arming: a rev before it is ignored
        while self.bench("state")["uptime_ms"] < until:
            time.sleep(0.05)

    def bench(self, op, **params):
        with socket.create_connection(("127.0.0.1", self.control), timeout=10) as s:
            s.sendall((json.dumps({"op": op, **params}) + "\n").encode())
            reply = json.loads(s.makefile().readline())
        assert reply.pop("ok"), reply
        return reply

    def ki(self):
        return self.bench("peek", names=["motors"])["values"]["motors"][1]["ki"]

    def until_own_ki(self):
        """The bare TUNE a stopped run sends drops its gains once the wheels stop."""
        deadline = time.monotonic() + 15
        while self.ki() != 0.5:
            assert time.monotonic() < deadline, f"still on ki {self.ki()}"
            time.sleep(0.1)

    def tune(self, *args):
        return [NPM, "run", "-s", "tune", "--", *map(str, args), "--port", f"socket://127.0.0.1:{self.serial}"]


@pytest.fixture
def sim():
    s = Sim()
    yield s
    s.proc.terminate()
    s.proc.wait(timeout=10)


def define(tmp_path, n):
    path = tmp_path / "definition.json"
    path.write_text(json.dumps({**GAINS_RUN, "form": {**GAINS_RUN["form"], "n": str(n)}}))
    return path


def test_a_run_from_the_command_line_ends_on_its_json_and_the_blasters_own_gains(sim, tmp_path):
    run_dir = tmp_path / "run"
    done = subprocess.run(sim.tune("start", run_dir, define(tmp_path, 2)), cwd=CONSOLE,
                          capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "status: done" in done.stdout
    assert "1. PID kp 0.2 ki 1: 2nd slowest" in done.stdout
    [saved] = run_dir.glob("tune-*.json")
    run = json.loads(saved.read_text())
    assert [s["id"] for s in run["sets"]] == ["baseline"] * 3 + ["PID kp 0.2 ki 1"] * 2 + ["baseline"] * 3
    files = {s["file"] for set_ in run["sets"] for s in set_["spinups"]}
    assert files == {p.name for p in run_dir.glob("*.csv")}
    sim.until_own_ki()


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no SIGINT to send a process")
def test_ctrl_c_pauses_a_run_on_the_blasters_own_gains_and_discard_saves_it(sim, tmp_path):
    run_dir = tmp_path / "run"
    cli = subprocess.Popen(sim.tune("start", run_dir, define(tmp_path, 20)), cwd=CONSOLE,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = []
    for line in cli.stdout:
        out.append(line)
        if line.startswith("set 4 "):
            cli.send_signal(signal.SIGINT)
    assert cli.wait(timeout=60) == 3, "".join(out)
    assert "status: paused\n" in out
    sim.until_own_ki()

    discarded = subprocess.run(sim.tune("discard", run_dir), cwd=CONSOLE, capture_output=True,
                               text=True, timeout=120)
    assert discarded.returncode == 0, discarded.stdout + discarded.stderr
    [saved] = run_dir.glob("tune-*.json")
    run = json.loads(saved.read_text())
    assert run["status"] == "paused"
    assert len(run["sets"]) in (4, 5)  # the spin-up under way when Ctrl-C came finishes its set
    assert not (run_dir / "stored-run.json").exists()
