"""The pack as the firmware reads it, through a divider that reads far below it for tens of seconds
after power-on. Measured once, on a v1.2: 3.3 V at 7.1 s against a real 13.2 V. RISE_MS is the
first-order time constant that one reading fits; the wheels have the whole pack from the start."""

import pytest
from helpers import armed_v12
from test_idle_hold import power_on_holding_rev

from trifolium_sim import FULLSPEED, IDLE

PACK_MV = 16400
RISE_MS = 24000
QUICK_RISE_MS = 5000  # still under the cutoff at 2 s, over it by 9 s: the same story, sooner
CUTOFF_MV = 4 * 3300  # the shipped 4S cutoff, which throttleReferenceVoltage_mv() floors at
TARGET = 30000
IDLE_RPM = 1000


def test_the_divider_climbs_from_power_on_stays_charged_through_a_reboot_and_starts_again_after_power(
        blaster):
    b = blaster
    b.set_pack(PACK_MV, rise_ms=QUICK_RISE_MS)
    armed_v12(b, display=False, settle_ms=0)
    assert b.peek("battery")["mv"] < PACK_MV * 0.3

    b.run_ms(20000)
    assert b.command("REBOOT")["rebooting"] is True
    assert b.run_until_reboot(2000) and b.wait_booted()
    assert b.peek("battery")["mv"] > PACK_MV * 0.95

    b.power_cycle()
    assert b.boot()
    assert b.peek("battery")["mv"] < PACK_MV * 0.3


def test_the_idle_kicked_at_power_on_stays_near_idle_while_the_divider_reads_low(blaster):
    """The kick divides by the reading, which is floored at the cutoff: at most pack / cutoff over,
    where the raw reading would ask for full throttle."""
    b = blaster
    b.set_pack(PACK_MV, rise_ms=RISE_MS)
    power_on_holding_rev(b, settle_ms=0)
    b.reset_peak(1)
    b.run_ms(5000)
    assert b.peek("idleHoldActive") is True
    assert IDLE_RPM * 0.5 < b.wheels()[1]["peak"] < IDLE_RPM * PACK_MV / CUTOFF_MV * 1.1


def test_a_rev_while_the_divider_reads_low_reaches_speed_without_running_away(blaster):
    b = blaster
    b.set_pack(PACK_MV, rise_ms=RISE_MS)
    armed_v12(b, display=False)
    assert b.peek("battery")["mv"] < CUTOFF_MV
    b.reset_peak(1)
    b.press("rev")
    assert b.run_until(lambda: b.peek("motors")[1]["motorRPM"] >= TARGET - 500, 500)
    b.run_ms(1500)
    assert b.wheels()[1]["peak"] < TARGET * 1.05
    assert b.wheels()[1]["rpm"] == pytest.approx(TARGET, rel=0.01)


def test_a_divider_still_rising_at_boot_does_not_cut_the_escs_for_the_session(blaster):
    b = blaster
    b.esc_startup()
    b.set_pack(PACK_MV, rise_ms=QUICK_RISE_MS)
    armed_v12(b, {"escEnablePin": 22}, display=False)
    b.run_ms(15000)
    assert b.peek("battery")["mv"] > CUTOFF_MV
    assert b.pin(22)["outputLevel"] is True


def test_a_pack_under_the_cutoff_at_idle_spins_down_cuts_the_escs_and_refuses_to_rev_until_reboot(
        blaster):
    b = armed_v12(blaster, {"escEnablePin": 22}, display=False)
    b.press("rev")
    assert b.run_until_peek("flywheelState", FULLSPEED, limit_ms=600)
    b.set_pack(12400)  # 3.1 V per cell
    b.run_ms(1500)
    assert b.peek("flywheelState") == FULLSPEED  # a rev's sag never trips it
    assert b.peek("lowVoltageCutoffTripped") is False

    b.tap("trigger")  # a shot starts the 1 s dwell over
    b.release("rev")
    b.run_ms(1500)  # the dwell holds the rev, so its sag does not count either
    assert b.peek("lowVoltageCutoffTripped") is False
    b.run_ms(900)  # a second under the cutoff since the dwell ended and the ramp began
    assert b.peek("lowVoltageCutoffTripped") is True
    assert b.peek("motors")[1]["targetRPM"] == 0
    assert b.pin(22)["outputLevel"] is False

    b.set_pack(13600)  # recovered over the cutoff with the load off
    fired = len(b.extends())
    b.press("rev")
    b.press("trigger")
    b.run_ms(1000)
    assert b.peek("flywheelState") == IDLE
    assert len(b.extends()) == fired
    b.release("trigger")
    b.release("rev")

    assert b.command("REBOOT")["rebooting"] is True
    assert b.run_until_reboot(2000) and b.wait_booted()
    b.run_ms(2500)
    assert b.pin(22)["outputLevel"] is True
    b.press("rev")
    assert b.run_until_peek("flywheelState", FULLSPEED, limit_ms=600)


def test_the_cutoff_trips_with_idle_hold_keeping_the_wheels_at_idle(blaster):
    b = power_on_holding_rev(blaster)
    assert b.peek("motors")[1]["targetRPM"] == IDLE_RPM
    b.set_pack(12400)
    b.run_ms(1100)
    assert b.peek("lowVoltageCutoffTripped") is True
    b.run_ms(500)
    assert b.peek("motors")[1]["targetRPM"] == 0
