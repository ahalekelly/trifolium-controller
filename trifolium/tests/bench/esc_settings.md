# ESCs tab on real AM32 ESCs

The console's ESCs tab (`tools/console/src/esc/`) is tested against a fake blaster built from
kelly-esc's `fourway.py` traces. This walk is what only real ESCs answer: that Trifolium's
passthrough forwards writes, that the layout tables match what AM32 stores, that a write is one
erase per ESC and verifies, and that the blaster drives its motors afterwards.

Needs a wired blaster with AM32 2.19 or later on its flywheel ESCs (settings layout 3 or 4), its
battery, Chrome, and a build of this console (`npm run dev` in `tools/console/`). Keep the log panel
open: each step names the lines to look for. Darts out, muzzle clear.

1. **Baseline from another tool.** Reboot > ESC Passthrough, read the ESCs in am32.ca, and note
   each motor's Timing advance, Startup power, PWM frequency, Ramp rate, Motor Kv, Motor poles and
   Beep volume. Disconnect there.
2. **Read.** Connect the console, open the ESCs tab, press Read ESCs. Expect a column per enabled
   flywheel motor, `Reading the ESCs: done.` in the log, and the console back on the blaster
   (Profile tab live) within about 10 s.
   - Every value from step 1 matches. A mismatch means a table offset or scale is wrong.
   - Firmware shows the version am32.ca showed, with layout 4 for 2.21 or 3 for 2.19-2.20.
   - "ESCs differ" appears only where the ESCs really differ.
3. **Write a harmless change.** Type Beep volume one higher than now and Write. Expect one
   `ESC n written and verified.` line per ESC and the new value in every column.
4. **It was stored.** Unplug the battery, wait 5 s, plug it in, then Read ESCs. The new beep volume
   is still there, and am32.ca (as in step 1) shows it too.
5. **No needless erase.** Write the same Beep volume again. Expect `already holds these values -
   not written.` for every ESC, and no `written` line.
6. **The motors still run.** Rev. Every wheel spins up and turns the way that fires: the write left
   each ESC's own direction alone.
7. **A spin-up setting.** Write Startup power 10 % higher, rev, and check the wheels reach speed.
   Write it back.
8. **No ESC power.** Unplug the battery and press Read ESCs. Expect, about 10 s later, an error
   that the ESC bootloader did not answer, and the console back on the blaster. Press Read ESCs
   again and plug the battery in while it waits: the read succeeds.
9. **Put it back.** Write the step 1 Beep volume.

Report any failure with the console log, saved from the log panel.
