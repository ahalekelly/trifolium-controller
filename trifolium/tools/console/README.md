# Trifolium console

The web console for configuring a Trifolium blaster over USB, built to one self-contained HTML file. `npm ci`, then `npm run dev` to work on it, `npm run build` to build `dist/index.html`, `npm test` for the tests. The [Web Console wiki page](../../wiki/Web-Console.md) is the user's guide.

## Tune runs from the command line

`npm run tune` runs the Tune tab's spin-up search without a browser, for an agent at the bench. It drives the same runner as the tab, so a run behaves the same way: it revs the blaster by itself, hundreds of times, so someone must be at the blaster to keep it safe and swap packs.

```sh
npm run tune -- start <run dir> <definition.json>   # a new run in an empty directory
npm run tune -- resume <run dir>                    # carry on a paused run
npm run tune -- discard <run dir>                   # drop a run, saving its JSON if it never finished
```

It opens the one Trifolium plugged in over USB, so close any console tab that has it connected first. `--port socket://127.0.0.1:<port>` opens the simulator's serial instead.

The run directory gets each capture's CSV as it comes in, the stored run (`stored-run.json`), and the run's JSON (`tune-<start>.json`) when it finishes or is discarded unfinished: the files the tab downloads. A directory holds one run. To watch a run, open its `stored-run.json` with **Open run file** on the console's Tune page.

Progress goes to stdout, each line led by the time: a line per finished set, per change of activity, status or note, and per console log line, the commands it sends included. The exit code says how it ended:

- 0: done, with the ranking printed, or discarded.
- 3: paused. The line before says why: a low pack, SAFE, a lost connection. Fix that, then `resume`, or `discard`.
- 1: an error, on stderr, such as a definition the run refuses.

Ctrl-C pauses the run after the spin-up under way, putting back the blaster's own gains and the ESCs' own settings. A second Ctrl-C quits at once, leaving any ESC settings owed for the next `resume` or `discard` to put back.

### Run definition

The Tune tab's form as JSON, each value as you would type it there; anything left out takes the tab's default.

```json
{
  "kind": "esc",
  "oneAtATime": true,
  "form": { "rpms": "30000", "n": "20", "cellV": "3.6" },
  "esc": { "startup_power": "80, 120", "advance_level": "7.5, 22.5" }
}
```

- `kind`: `"esc"` searches the flywheel ESCs' AM32 settings, `"gains"` the flywheel gains.
- `oneAtATime` (ESC runs): try each value on the ESCs' own settings, rather than every combination.
- `form`: `rpms` (target RPMs), `n` (spin-ups per candidate), `cellV` (pause below this many volts a cell), and for gains runs `kp`, `ki`, `tbh` and `overshootLimitPct`.
- `esc`: values to try for each setting, by AM32 field name. A name the ESCs do not have, or cannot search, is refused with the list of those they can.
- `mode` (gains runs): `"pid"`, `"tbh"` or `"both"`.
