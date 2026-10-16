"""TUNE, the console's spin-up search trial: a rev RPM, control mode and gains for every enabled
motor, held in RAM alone. A v1.2 drives motors 2 and 4."""

import json

from helpers import armed_v12

PID = {"revRPM": 25000, "control": "pid", "kp": 0.6, "ki": 1.5}


def tune(b, **changes):
    return b.command("TUNE " + json.dumps({**PID, **changes}))


def capture(b, hold_ms=1000):
    """Revs from rest for `hold_ms`, then returns the rpmCapture report that follows the dump."""
    mark = len(b.transcript)
    b.press("rev")
    b.run_ms(hold_ms)
    b.release("rev")
    assert b.run_until(lambda: '"evt":"rpmCapture"' in b.transcript[mark:], 3000)
    line = next(l for l in b.transcript[mark:].splitlines() if '"evt":"rpmCapture"' in l)
    b.run_ms(3000)
    return json.loads(line)


def test_tune_drives_every_motor_at_its_rpm_and_gains_until_a_reboot_and_writes_nothing(blaster):
    b = armed_v12(blaster, display=False)
    stored, device = b.flash_json("/device.cfg"), b.command("DUMP_DEVICE")
    assert tune(b) == {"cmd": "TUNE", "ok": True, "clamped": False, "rebooting": False}
    for i in (1, 3):
        m = b.peek("motors")[i]
        assert (m["revRPM"], round(m["kp"], 3), round(m["ki"], 3)) == (25000, 0.6, 1.5)
    b.press("rev")
    b.run_ms(1500)
    assert abs(b.peek("motors")[1]["motorRPM"] - 25000) < 300
    b.release("rev")

    assert b.flash_json("/device.cfg") == stored
    assert b.command("DUMP_DEVICE") == device
    b.power_cycle()
    assert b.boot(100)
    m = b.peek("motors")[1]
    assert (m["revRPM"], round(m["kp"], 3)) == (30000, device["motorConfig"][1]["kp"])


def test_tune_is_refused_while_the_wheels_turn_and_for_anything_out_of_range(blaster):
    b = armed_v12(blaster, display=False)
    b.press("rev")
    b.run_ms(300)
    assert tune(b)["err"] == "flywheels are running"
    b.release("rev")
    b.run_ms(3000)

    assert tune(b, kp=2.5)["err"] == "gain out of range"
    assert tune(b, ki=-1)["err"] == "gain out of range"
    assert tune(b, revRPM=99999)["err"] == "revRPM out of range"
    assert tune(b, control="pd")["err"] == "needs revRPM, control (pid or tbh), kp and ki"
    assert b.command("TUNE {}")["err"] == "needs revRPM, control (pid or tbh), kp and ki"
    assert b.command("TUNE kp=1")["err"] == "invalid JSON"
    assert b.peek("motors")[1]["revRPM"] == 30000


def test_each_capture_reports_when_the_wheels_were_fire_ready_or_that_the_rampup_timed_out(blaster):
    b = armed_v12(blaster, {"useRpmLogging": True, "rpmLogLength": 1200}, display=False)
    assert tune(b, revRPM=30000, kp=0.02, ki=0.5)["ok"]
    slow = capture(b)
    assert tune(b, revRPM=30000, kp=0.2, ki=0.5)["ok"]
    fast = capture(b)
    assert 0 < fast["readyMs"] < slow["readyMs"] < 500  # deviceSettings.rampupTimeout_ms
    assert fast["timedOut"] is False and fast["slowestMotor"] in (1, 3)

    # No proportional term: the open-loop throttle alone settles short of the firing tolerance.
    assert tune(b, revRPM=30000, kp=0, ki=0)["ok"]
    stuck = capture(b)
    assert stuck == {"evt": "rpmCapture", "readyMs": None, "slowestMotor": stuck["slowestMotor"],
                     "timedOut": True}

    assert tune(b, control="tbh", revRPM=30000, ki=0.05)["ok"]
    assert capture(b)["readyMs"] < 500
