"""The console's Rev and Fire buttons: HOLD resent as a keepalive, then RELEASE. A hold reads as the
physical switch pressed, so every rule that governs the switch governs the button."""

from helpers import armed_v12, open_menu
from trifolium_sim import FULLSPEED, IDLE

OK = {"ok": True, "clamped": False, "rebooting": False}


def hold_for(b, role, ms):
    """Holds `role` from the console for `ms`, resending HOLD every 100 ms as the console does."""
    for _ in range(ms // 100):
        assert b.command(f"HOLD {role}") == {"cmd": "HOLD", **OK}
        b.run_ms(100)


def test_a_held_rev_revs_and_a_release_spins_down_even_with_no_rev_switch(blaster):
    b = armed_v12(blaster, {"revSwitchPin": 255}, display=False)
    hold_for(b, "rev", 1500)
    assert b.peek("flywheelState") == FULLSPEED
    assert b.command("RELEASE rev") == {"cmd": "RELEASE", **OK}
    assert b.run_until_peek("flywheelState", IDLE, limit_ms=500)


def test_a_hold_that_is_not_renewed_lets_go_on_its_own(blaster):
    """A dropped link or a closed tab must never leave the blaster revving."""
    b = armed_v12(blaster, display=False)
    hold_for(b, "rev", 1500)
    assert b.peek("flywheelState") == FULLSPEED
    b.run_ms(400)
    assert b.peek("flywheelState") == IDLE


def test_a_held_fire_goes_through_the_fire_mode_like_a_trigger_pull(blaster):
    """A three-round burst: three darts however long the hold."""
    b = blaster
    b.flash_preset("trifolium_v1_2")
    b.flash_profile(1, {"schemaVersion": 2, "activeModeCount": 1, "defaultFiringMode": 0,
                        "switchPositionAssignment": [0, 0, 0],
                        "fireModes": [{"burstMode": "burst", "burstLength": 3, "targetDPS": 15,
                                       "reversible": False, "includeInCycle": True}]})
    assert b.boot(2500)
    hold_for(b, "trigger", 2000)
    b.command("RELEASE trigger")
    b.run_ms(1000)
    assert len(b.extends()) == 3


def test_safe_holds_off_a_held_rev_and_fire(blaster):
    b = armed_v12(blaster, {"safetySwitchPin": 11}, display=False)
    b.press("select0")
    b.press("safety")
    b.run_ms(100)
    hold_for(b, "rev", 1000)
    hold_for(b, "trigger", 1000)
    assert b.extends() == []
    assert b.peek("flywheelState") == IDLE


def test_a_hold_does_nothing_while_the_menu_is_open(blaster):
    b = armed_v12(blaster)
    open_menu(b)
    hold_for(b, "rev", 400)
    assert b.peek("flywheelState") == IDLE
    assert b.command("HOLD pusher")["err"] == "needs rev or trigger"
