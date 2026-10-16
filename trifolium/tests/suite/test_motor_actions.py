"""The menu's per-motor actions, run over serial for the console. A v1.2 drives motors 2 and 4."""

from helpers import armed_v12, enter, open_menu, select


def refusal(b, line):
    reply = b.command(line)
    assert reply["ok"] is False, reply
    return reply


def test_test_motor_spins_that_motor_alone_and_answers_once_it_has_stopped(blaster):
    b = armed_v12(blaster, display=False)
    b.reset_peak(1)
    b.reset_peak(3)
    assert b.command("TEST_MOTOR 1") == {"cmd": "TEST_MOTOR", "ok": True, "index": 1,
                                         "clamped": False, "rebooting": False}
    wheels = b.wheels()
    assert wheels[1]["peak"] > 1000
    assert wheels[3]["peak"] < 100
    assert b.escs()[1]["lastThrottle"] == 0


def test_a_motor_not_attached_this_boot_is_refused_by_index(blaster):
    b = armed_v12(blaster, display=False)
    assert refusal(b, "TEST_MOTOR 0") == {"cmd": "TEST_MOTOR", "ok": False, "index": 0,
                                          "err": "motor not attached this boot"}
    assert refusal(b, "TEST_MOTOR")["err"] == "needs a motor index 0-3"
    assert refusal(b, "TEST_MOTOR 4")["err"] == "needs a motor index 0-3"


def test_a_motor_action_is_refused_while_the_flywheels_run(blaster):
    b = armed_v12(blaster, display=False)
    b.press("rev")
    b.run_ms(300)
    assert refusal(b, "TEST_MOTOR 1")["err"] == "flywheels are running"
    b.release("rev")
    assert b.run_until_peek("flywheelState", 0)  # STATE_IDLE
    b.run_ms(2000)
    assert b.command("TEST_MOTOR 1")["ok"]


def test_a_motor_action_is_refused_while_the_menu_runs_one(blaster):
    """The menu's spin polls serial, so a command can arrive in the middle of it."""
    b = armed_v12(blaster)
    open_menu(b)
    enter(b, "Advanced", "Motors & PID", "Motor 2")
    select(b, "Test This Motor")
    b.tap("menu")
    assert b.run_until(lambda: b.panel().shows("any press = stop"), 500, step_ms=5)
    assert refusal(b, "TEST_MOTOR 3")["err"] == "a motor action is already running"
