"""Lifetime usage stats: darts fired, the highest ESC current-sense reading and the hottest ESC,
recorded every tick and stored once the wheels have been stopped for 5 s."""

from helpers import armed_v12, enter, open_menu, select

STATS = "/stats.cfg"
CURRENT_PIN = 26
STORED_MS = 8000  # the wheels spin down, then stay stopped for the 5 s the save waits for


def test_shots_current_and_esc_temperature_are_stored_once_the_wheels_stop(blaster):
    b = armed_v12(blaster, display=False)
    b.press("select2")  # SEMI in the default profile
    b.analog(CURRENT_PIN, 310)  # the ESC's current-sense output at 1000 mV
    b.tap("trigger")
    b.run_ms(300)
    b.esc_reply(1, edt="temperature", value=47)
    b.run_ms(50)
    assert b.command("DUMP_STATS") == {"cmd": "DUMP_STATS", "ok": True, "shotsFired": 1,
                                       "maxCurrent_mv": 1000, "maxEscTemp_C": 47}
    assert b.flash_get(STATS) is None  # the wheels are still turning

    b.run_ms(STORED_MS)
    assert b.flash_json(STATS) == {"shotsFired": 1, "maxCurrent_mv": 1000, "maxEscTemp_C": 47}


def test_the_stats_survive_a_power_cut_and_keep_counting(blaster):
    b = armed_v12(blaster, display=False)
    b.press("select2")
    b.tap("trigger")
    b.run_ms(STORED_MS)
    b.power_cycle()
    assert b.boot(2500)
    b.press("select2")
    b.tap("trigger")
    b.run_ms(STORED_MS)
    assert b.flash_json(STATS)["shotsFired"] == 2


def test_a_cooler_reading_leaves_the_record(blaster):
    b = armed_v12(blaster, display=False)
    b.esc_reply(1, edt="temperature", value=60)
    b.run_ms(50)
    b.esc_reply(1, edt="temperature", value=40)
    b.run_ms(50)
    assert b.command("DUMP_STATS")["maxEscTemp_C"] == 60


def test_reset_clears_the_records_on_flash(blaster):
    b = armed_v12(blaster, display=False)
    b.press("select2")
    b.tap("trigger")
    b.run_ms(STORED_MS)
    assert b.flash_json(STATS)["shotsFired"] == 1
    assert b.command("RESET_STATS")["ok"]
    b.run_ms(50)  # long stopped, so saved at once
    assert b.flash_json(STATS) == {"shotsFired": 0, "maxCurrent_mv": 0, "maxEscTemp_C": 0}


def test_the_current_sense_reading_at_rest_is_not_a_record(blaster):
    b = armed_v12(blaster, display=False)
    b.analog(CURRENT_PIN, 310)
    b.run_ms(50)
    assert b.command("DUMP_STATS")["maxCurrent_mv"] == 0


def test_the_device_menu_shows_the_records(blaster):
    b = armed_v12(blaster, settle_ms=3000)
    b.esc_reply(1, edt="temperature", value=52)
    b.run_ms(50)
    open_menu(b)
    enter(b, "Advanced", "Device", "Usage Stats")
    text = b.panel().text
    assert "Darts fired: 0" in text
    assert "Peak current: --" in text
    assert "Hottest ESC: 52C" in text
