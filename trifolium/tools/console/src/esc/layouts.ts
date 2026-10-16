// What the bytes of an AM32 settings block mean, one hand-written table per layout.
//
// The block is AM32's EEprom_t (Inc/eeprom.h), stored in the ESC's flash. Byte 1, eeprom_version,
// is the only thing that says how the rest is laid out, so it alone picks the table; a version with
// no table is refused rather than read through the nearest one. The running app rewrites byte 1 to
// its own EEPROM_VERSION at boot (main.c), so the version names the firmware that last ran, not
// whatever wrote the block before it.
//
// A table lists the fields this console shows and writes, by AM32's own field names, which is what
// a write is addressed by. Bytes no table names - the reserved bytes, the startup melody, CAN - are
// carried over untouched by every write. So are some named in eeprom.h on purpose:
//
// - dir_reversed: the blaster sets each motor's direction itself, over DShot, and it differs from
//   motor to motor by design.
// - input_type, bi_direction, rc_car_reverse, use_hall_sensors, disable_stick_calibration and the
//   servo block: a blaster drives its ESCs with one-way DShot, and these either mean nothing there
//   or stop the motors answering it.
//
// `searchable` marks the fields a spin-up optimiser may vary over their whole range, Off included
// where they have one: the ones AM32 reads while taking a motor from stopped to speed (Src/main.c),
// and nothing that is a fact about the hardware (poles) or a protection that exists to stop it
// (limits, cutoffs). motor_kv is searchable because on the ESC it is no fact: Trifolium keeps the
// motor's real Kv in its own device settings, and AM32 uses its copy only for the RPM range of its
// low-RPM power protection, which Off disables.
//
// Adding a layout - a new upstream EEPROM_VERSION, or a custom build's 200+ - is one entry in
// LAYOUTS and nothing else.

/** sizeof(EEprom_t), and what AM32 erases and rewrites as one. */
export const BLOCK_SIZE = 192;

export interface EscField {
  /** Byte offset in the block. Every field is one byte. */
  offset: number;
  /** AM32's eeprom.h name, nested ones dotted, and the key a write is addressed by. */
  name: string;
  label: string;
  /** The raw byte values AM32 acts on as numbers. */
  min: number;
  max: number;
  /**
   * For a setting AM32 turns off with a value outside min..max: the value written for Off. Every
   * raw value outside the range reads as Off, as AM32 treats it.
   */
  off: { raw: number; label: string } | null;
  /** Shown as raw * scale + shift, in `unit`. */
  scale: number;
  shift: number;
  unit: string;
  /** A label for each raw value from min, for a field that is a choice rather than a number. */
  options: string[] | null;
  searchable: boolean;
}

export interface EscLayout {
  version: number;
  fields: EscField[];
}

interface Shown {
  scale?: number;
  shift?: number;
  unit?: string;
  off?: { raw: number; label: string };
  searchable?: boolean;
}

const OFF = (raw: number) => ({ raw, label: "Off" });

const num = (
  offset: number,
  name: string,
  label: string,
  min: number,
  max: number,
  { scale = 1, shift = 0, unit = "", off, searchable = false }: Shown = {},
): EscField => ({
  offset,
  name,
  label,
  min,
  max,
  off: off ?? null,
  scale,
  shift,
  unit,
  options: null,
  searchable,
});

const choice = (
  offset: number,
  name: string,
  label: string,
  options: string[],
  searchable = false,
): EscField => ({
  offset,
  name,
  label,
  min: 0,
  max: options.length - 1,
  off: null,
  scale: 1,
  shift: 0,
  unit: "",
  options,
  searchable,
});

const OFF_ON = ["Off", "On"];

/**
 * EEPROM_VERSION 4, AM32 2.21 on. Ranges are am32-configurator's (pages/configurator.vue), checked
 * against what loadEEpromSettings() accepts.
 */
const V4: EscField[] = [
  // Startup and drive: what a spin-up search varies.
  // The duty cycle may rise by at most this per millisecond - the direct cap on how hard a motor is
  // pushed from rest. Below 1.0 %/ms AM32 switches to a finer ramp divider.
  num(5, "max_ramp", "Ramp rate", 1, 200, { scale: 0.1, unit: "% duty/ms", searchable: true }),
  // Duty added on top of the minimum while starting, before back-EMF is tracked.
  num(25, "startup_power", "Startup power", 50, 150, { unit: "%", searchable: true }),
  // 10-42 encodes 0-32 steps of 0.9375 degrees; temp_advance is the raw value less 10.
  num(23, "advance_level", "Timing advance", 10, 42, {
    scale: 0.9375,
    shift: -9.375,
    unit: "°",
    searchable: true,
  }),
  choice(47, "auto_advance", "Auto timing advance", OFF_ON, true),
  num(24, "pwm_frequency", "PWM frequency", 8, 144, { unit: "kHz", searchable: true }),
  choice(21, "variable_pwm", "PWM type", ["Fixed", "Variable", "By RPM"], true),
  // Active freewheeling. Sine startup needs it, and AM32 turns sine startup off without it.
  choice(20, "comp_pwm", "Complementary PWM", OFF_ON, true),
  choice(19, "use_sine_start", "Sinusoidal startup", OFF_ON, true),
  num(40, "sine_mode_changeover_thottle_level", "Sine mode range", 5, 25, {
    unit: "%",
    searchable: true,
  }),
  num(45, "sine_mode_power", "Sine mode power", 1, 10, { searchable: true }),
  // Both cut or boost drive when the rotor is slow to turn, which is exactly a hard spin-up.
  choice(22, "stuck_rotor_protection", "Stuck rotor protection", OFF_ON, true),
  choice(29, "stall_protection", "Stall protection", OFF_ON, true),
  num(6, "minimum_duty_cycle", "Minimum duty cycle", 0, 50, { scale: 0.5, unit: "%" }),

  // Kv and poles set the RPM range of AM32's low-RPM power protection, which limits duty while the
  // motor turns slowly; Kv 20 (raw 0) turns that protection off instead. Trifolium's own Kv and
  // poles are its device settings, not these.
  num(27, "motor_poles", "Motor poles", 2, 36),
  num(26, "motor_kv", "Motor Kv", 1, 255, {
    scale: 40,
    shift: 20,
    unit: "Kv",
    off: { raw: 0, label: "Off (low-RPM power protection disabled)" },
    searchable: true,
  }),

  // Braking.
  choice(28, "brake_on_stop", "Brake on stop", ["Off", "Brake on stop", "Active brake"]),
  choice(13, "brake_on_zero_throttle", "Zero-throttle braking", [
    "Default",
    "Coast",
    "Brake",
    ...[1, 2, 3, 4, 5, 6, 7].map((s) => `Brake after ${s} s`),
  ]),
  // Duty is raw * 0.5 %, on top of the dead-time duty AM32 always adds when braking.
  num(12, "active_brake_power", "Active brake power", 0, 5, { scale: 0.5, unit: "% duty" }),
  num(41, "drag_brake_strength", "Brake strength", 1, 10),
  num(42, "driving_brake_strength", "Running brake level", 1, 9, { off: OFF(10) }),

  // Protections.
  choice(36, "low_voltage_cut_off", "Low voltage cutoff", ["Off", "Cell based", "Absolute"]),
  num(37, "low_cell_volt_cutoff", "Cell cutoff voltage", 0, 100, {
    scale: 0.01,
    shift: 2.5,
    unit: "V/cell",
  }),
  num(8, "absolute_voltage_cutoff", "Absolute cutoff voltage", 1, 100, { scale: 0.5, unit: "V" }),
  // AM32 rewrites a temperature outside 70-140 as 255, its own Off.
  num(43, "limits.temperature", "Temperature limit", 70, 140, { unit: "°C", off: OFF(255) }),
  num(44, "limits.current", "Current limit", 1, 100, { scale: 2, unit: "A", off: OFF(0) }),
  num(9, "current_P", "Current P", 0, 255),
  num(10, "current_I", "Current I", 0, 255),
  num(11, "current_D", "Current D", 0, 255),

  num(30, "beep_volume", "Beep volume", 0, 11),
];

/**
 * Layout 3, AM32 2.19 and 2.20: 4 without zero-throttle braking, whose byte 13 it reserved, and
 * with a current limit that is on only below 100 (200 A).
 */
const V3: EscField[] = V4.filter((f) => f.name !== "brake_on_zero_throttle").map((f) =>
  f.name === "limits.current" ? { ...f, max: 99 } : f,
);

/**
 * Every layout this console reads and writes, by eeprom_version. Earlier versions kept the
 * firmware's name in bytes 5-16 and had no fields there.
 */
export const LAYOUTS: Record<number, EscLayout> = {
  3: { version: 3, fields: V3 },
  4: { version: 4, fields: V4 },
};

/** The layout a block's eeprom_version names, or a loud refusal. */
export function layoutOf(block: Uint8Array): EscLayout {
  const version = block[1];
  const layout = LAYOUTS[version];
  if (!layout) {
    const known = Object.keys(LAYOUTS).join(", ");
    throw new Error(
      `ESC settings layout ${version} is not one this console knows (it knows ${known}). ` +
        (version === 0xff
          ? "The block is blank: the ESC's firmware has never run."
          : "Flash the ESC with AM32 2.19 or later, or use a console that knows this layout."),
    );
  }
  return layout;
}

/** "2.21", from bytes 3 and 4. */
export const firmwareOf = (block: Uint8Array): string =>
  `${block[3]}.${String(block[4]).padStart(2, "0")}`;

/** A raw value as shown. Rounded so 0.1-step scales do not show as 0.30000000000000004. */
export function shown(field: EscField, raw: number): string {
  if (field.options) return field.options[raw - field.min] ?? `${raw} (unknown)`;
  if (field.off && (raw < field.min || raw > field.max)) return field.off.label;
  const value = Number((raw * field.scale + field.shift).toFixed(4));
  return field.unit ? `${value} ${field.unit}` : String(value);
}

/** The raw byte nearest a shown value, which may be outside the field's range. */
export const rawFrom = (field: EscField, value: number): number =>
  Math.round((value - field.shift) / field.scale);

/**
 * A block with `values` (raw, by field name) written into it, leaving every other byte as it was.
 * A name the layout lacks or a value outside its field's range throws, naming both.
 */
export function withValues(block: Uint8Array, values: Record<string, number>): Uint8Array {
  const layout = layoutOf(block);
  const out = block.slice();
  for (const [name, value] of Object.entries(values)) {
    const field = layout.fields.find((f) => f.name === name);
    if (!field) throw new Error(`ESC settings layout ${layout.version} has no field ${name}`);
    const inRange = Number.isInteger(value) && value >= field.min && value <= field.max;
    if (!inRange && value !== field.off?.raw) {
      const off = field.off ? `, or ${field.off.raw} for Off` : "";
      throw new Error(
        `${name} must be a whole number from ${field.min} to ${field.max}${off}, not ${value}`,
      );
    }
    out[field.offset] = value;
  }
  return out;
}
