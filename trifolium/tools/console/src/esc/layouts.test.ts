import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, LAYOUTS, firmwareOf, layoutOf, rawFrom, shown, withValues } from "./layouts";
import { V2_DEFAULT, V4_DEFAULT } from "./testdata";

const field = (version: number, name: string) =>
  LAYOUTS[version].fields.find((f) => f.name === name)!;

describe("every layout table", () => {
  for (const layout of Object.values(LAYOUTS)) {
    it(`v${layout.version} is keyed by its own version and is well formed`, () => {
      expect(LAYOUTS[layout.version]).toBe(layout);
      const offsets = layout.fields.map((f) => f.offset);
      expect(new Set(offsets).size).toBe(offsets.length);
      expect(new Set(layout.fields.map((f) => f.name)).size).toBe(offsets.length);
      for (const f of layout.fields) {
        // Bytes 0-4 are the bootloader's and the firmware's own: layout, versions.
        expect(f.offset).toBeGreaterThanOrEqual(5);
        expect(f.offset).toBeLessThan(BLOCK_SIZE);
        expect(f.min).toBeLessThanOrEqual(f.max);
        expect(f.max).toBeLessThanOrEqual(255);
        if (f.options) expect(f.options).toHaveLength(f.max - f.min + 1);
        if (f.off) expect(f.off.raw < f.min || f.off.raw > f.max).toBe(true);
      }
    });
  }
});

describe("the v4 table", () => {
  it("places fields where Inc/eeprom.h does", () => {
    const at = Object.fromEntries(LAYOUTS[4].fields.map((f) => [f.name, f.offset]));
    expect(at).toMatchObject({
      max_ramp: 5,
      brake_on_zero_throttle: 13,
      comp_pwm: 20,
      advance_level: 23,
      pwm_frequency: 24,
      startup_power: 25,
      motor_kv: 26,
      motor_poles: 27,
      "limits.current": 44,
      auto_advance: 47,
    });
  });

  it("leaves the motor's direction alone, since the blaster sets that per motor", () => {
    expect(LAYOUTS[4].fields.some((f) => f.offset === 17)).toBe(false);
  });

  it("reads the configurator's default block as AM32 means it", () => {
    expect(layoutOf(V4_DEFAULT).version).toBe(4);
    expect(firmwareOf(V4_DEFAULT)).toBe("2.21");
    expect(shown(field(4, "advance_level"), V4_DEFAULT[23])).toBe("15 °");
    expect(shown(field(4, "pwm_frequency"), V4_DEFAULT[24])).toBe("24 kHz");
    expect(shown(field(4, "motor_kv"), V4_DEFAULT[26])).toBe("2220 Kv");
    expect(shown(field(4, "motor_poles"), V4_DEFAULT[27])).toBe("14");
    expect(shown(field(4, "max_ramp"), V4_DEFAULT[5])).toBe("16 % duty/ms");
    expect(shown(field(4, "variable_pwm"), V4_DEFAULT[21])).toBe("Variable");
    expect(shown(field(4, "active_brake_power"), 5)).toBe("2.5 % duty");
  });

  it("marks the spin-up fields searchable and nothing else", () => {
    expect(LAYOUTS[4].fields.filter((f) => f.searchable).map((f) => f.name).sort()).toEqual([
      "advance_level",
      "auto_advance",
      "comp_pwm",
      "max_ramp",
      "motor_kv",
      "pwm_frequency",
      "sine_mode_changeover_thottle_level",
      "sine_mode_power",
      "stall_protection",
      "startup_power",
      "stuck_rotor_protection",
      "use_sine_start",
      "variable_pwm",
    ]);
  });
});

describe("the v3 table", () => {
  it("is v4 without zero-throttle braking, whose byte v3 reserved", () => {
    expect(LAYOUTS[3].fields.map((f) => f.name)).toEqual(
      LAYOUTS[4].fields.map((f) => f.name).filter((n) => n !== "brake_on_zero_throttle"),
    );
  });
});

describe("layoutOf", () => {
  it("refuses a layout with no table, naming it", () => {
    // v2 kept the firmware's name where v3 put the ramp and current settings.
    expect(() => layoutOf(V2_DEFAULT)).toThrow(/layout 2 is not one this console knows/);
  });

  it("says a blank block is blank", () => {
    expect(() => layoutOf(new Uint8Array(BLOCK_SIZE).fill(0xff))).toThrow(/never run/);
  });
});

describe("Off", () => {
  it("shows every disabled protection as Off, as each layout's AM32 treats it", () => {
    const temperature = field(4, "limits.temperature");
    expect([69, 70, 140, 141, 255].map((raw) => shown(temperature, raw))).toEqual([
      "Off",
      "70 °C",
      "140 °C",
      "Off",
      "Off",
    ]);
    // 2.21 limits current up to raw 100; 2.19 and 2.20 only below it.
    expect([0, 1, 100, 101].map((raw) => shown(field(4, "limits.current"), raw))).toEqual([
      "Off",
      "2 A",
      "200 A",
      "Off",
    ]);
    expect(shown(field(3, "limits.current"), 100)).toBe("Off");
    expect(shown(field(4, "driving_brake_strength"), 10)).toBe("Off");
  });

  it("shows Kv 20 as low-RPM power protection off", () => {
    expect(shown(field(4, "motor_kv"), 0)).toBe("Off (low-RPM power protection disabled)");
    expect(shown(field(4, "motor_kv"), 1)).toBe("60 Kv");
  });

  it("writes Off as its own raw value and nothing else outside the range", () => {
    expect(withValues(V4_DEFAULT, { "limits.temperature": 255 })[43]).toBe(255);
    expect(() => withValues(V4_DEFAULT, { "limits.temperature": 141 })).toThrow(/255 for Off/);
  });
});

describe("shown and rawFrom", () => {
  it("round-trip every raw value of every field", () => {
    for (const f of LAYOUTS[4].fields) {
      if (f.options) continue;
      for (let raw = f.min; raw <= f.max; raw++) {
        expect(rawFrom(f, Number.parseFloat(shown(f, raw)))).toBe(raw);
      }
    }
  });
});

describe("withValues", () => {
  it("writes the named fields and no other byte", () => {
    const next = withValues(V4_DEFAULT, { advance_level: 30, startup_power: 120 });
    expect(next[23]).toBe(30);
    expect(next[25]).toBe(120);
    const changed = [...next.keys()].filter((i) => next[i] !== V4_DEFAULT[i]);
    expect(changed).toEqual([23, 25]);
    expect(V4_DEFAULT[23]).toBe(26); // a copy, not the block it was given
  });

  it("refuses a field the layout lacks", () => {
    const v3 = V4_DEFAULT.slice();
    v3[1] = 3;
    expect(() => withValues(v3, { brake_on_zero_throttle: 1 })).toThrow(/layout 3 has no field/);
  });

  it("refuses a value outside the field's range or not a whole number", () => {
    expect(() => withValues(V4_DEFAULT, { advance_level: 43 })).toThrow(/10 to 42/);
    expect(() => withValues(V4_DEFAULT, { startup_power: 100.5 })).toThrow(/whole number/);
  });
});
