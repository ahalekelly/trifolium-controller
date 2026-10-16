"""The pack as the firmware reads it, through a divider that reads far below it for tens of seconds
after power-on. Measured once, on a v1.2: 3.3 V at 7.1 s against a real 13.2 V. RISE_MS is the
first-order time constant that one reading fits; the wheels have the whole pack from the start."""

import pytest
from helpers import armed_v12
from test_idle_hold import power_on_holding_rev

from trifolium_sim import FULLSPEED

PACK_MV = 16400
RISE_MS = 24000
QUICK_RISE_MS = 5000  # still under the cutoff at 2 s, over it by 9 s: the same story, sooner
CUTOFF_MV = 4 * 3300  # the shipped 4S cutoff, which throttleReferenceVoltage_mv() floors at
TARGET = 30000
IDLE = 1000


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
    assert IDLE * 0.5 < b.wheels()[1]["peak"] < IDLE * PACK_MV / CUTOFF_MV * 1.1


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


def test_with_nothing_reading_the_pack_it_is_taken_as_3_5_v_a_cell_and_never_cut_or_warned(blaster):
    """A board with no divider: the firmware works from 3.5 V a cell - under the 3.7 V warning - and
    skips the cutoff and the warning altogether. It fires, and nothing will stop it running a pack
    flat either."""
    b = blaster
    armed_v12(b, {"batteryAdcPin": 255, "escEnablePin": 22, "ledDataPin": 20,
                  "ledWarningMode": "warn_batt"}, display=False)
    assert b.peek("battery") == {"defined": False, "mv": 4 * 3500}
    armed_at = b.uptime_us
    b.press("trigger")
    assert b.run_until(lambda: len(b.extends()) >= 1, 1500)
    b.release("trigger")
    b.run_ms(3000)
    assert b.pin(22)["outputLevel"] is True  # the ESCs were never cut
    assert len(b.edges(20, armed_at)) <= 1  # the LED came on, at most, and never blinked


def test_a_divider_still_rising_at_boot_does_not_cut_the_escs_for_the_session(blaster):
    b = blaster
    b.esc_startup()
    b.set_pack(PACK_MV, rise_ms=QUICK_RISE_MS)
    armed_v12(b, {"escEnablePin": 22}, display=False)
    b.run_ms(15000)
    assert b.peek("battery")["mv"] > CUTOFF_MV
    assert b.pin(22)["outputLevel"] is True


def test_a_pack_under_the_cutoff_at_rest_spins_down_and_cuts_the_escs_until_it_reads_over_it(
        blaster):
    b = armed_v12(blaster, {"escEnablePin": 22}, display=False)
    b.press("rev")
    assert b.run_until_peek("flywheelState", FULLSPEED, limit_ms=600)
    b.set_pack(12400)  # 3.1 V per cell
    b.run_ms(1500)
    assert b.peek("flywheelState") == FULLSPEED  # a rev's sag never trips it

    b.tap("trigger")  # a shot starts the 1 s dwell over
    b.release("rev")
    b.run_ms(1500)  # the dwell holds the rev, so its sag does not count either
    assert b.peek("lowVoltageCutoffTripped") is False
    b.run_ms(900)  # a second under the cutoff since the dwell ended and the ramp began
    assert b.peek("lowVoltageCutoffTripped") is True
    assert b.peek("motors")[1]["targetRPM"] == 0
    assert b.pin(22)["outputLevel"] is False

    fired = len(b.extends())
    b.press("rev")
    b.press("trigger")
    b.run_ms(1000)
    assert b.peek("motors")[1]["targetRPM"] == 0
    assert len(b.extends()) == fired
    b.release("trigger")

    b.set_pack(13600)  # back over the cutoff
    assert b.run_until_peek("flywheelState", FULLSPEED, limit_ms=1600)
    assert b.pin(22)["outputLevel"] is True


def test_the_cutoff_trips_with_idle_hold_keeping_the_wheels_at_idle(blaster):
    b = power_on_holding_rev(blaster)
    assert b.peek("motors")[1]["targetRPM"] == IDLE
    b.set_pack(12400)
    b.run_ms(1100)
    assert b.peek("lowVoltageCutoffTripped") is True
    b.run_ms(500)
    assert b.peek("motors")[1]["targetRPM"] == 0


def test_the_cutoff_ends_a_post_rev_idle_window(blaster):
    b = blaster
    b.flash_profile(1, {"schemaVersion": 2, "dwellTime_ms": 0, "idleTime_ms": 10000})
    armed_v12(b, display=False)
    b.press("rev")
    assert b.run_until_peek("flywheelState", FULLSPEED, limit_ms=600)
    b.release("rev")
    b.set_pack(12400)
    b.run_ms(900)
    assert b.peek("motors")[1]["targetRPM"] == IDLE
    b.run_ms(600)
    assert b.peek("lowVoltageCutoffTripped") is True
    assert b.peek("motors")[1]["targetRPM"] == 0
