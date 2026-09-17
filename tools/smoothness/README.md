# smoothness — measuring smoothness on the finished video

Measures, on the finished MP4, how smoothly a movement passes from frame to
frame, and counts **hitches** (the tool prints them as `Haker`). Method,
definitions and limits:
[`docs/SMOOTHNESS.md`](../../docs/SMOOTHNESS.md).

This is a checking tool. Nothing in `src/` imports it, it never runs at the
customer's, and it changes nothing about the capture.

Its command-line switches and JSON keys are German, because its output is; the
prose here is English. `--lauf` is the run directory, `--vergleiche` compares
reports, `--erklaere-schwelle` explains the thresholds.

## Why Python in a TypeScript repository

The image mathematics (Fourier phase correlation, Lucas-Kanade pyramids,
affine back-shifting) stays a proven library — OpenCV and NumPy — rather than
code written here. In this project two home-made measuring instruments have
already been wrong by half (`src/paint-rate.ts`, the first version of
`src/efficiency.ts`). A third set of our own arithmetic, this time over pixels,
would be the third opportunity for the same mistake.

## Invocation

Set up dependencies once (Python 3.11–3.13, `uv`, `ffmpeg`):

```sh
uv sync --project tools/smoothness
```

A run against the truth of the product — this is the recommended form:

```sh
uv run --project tools/smoothness smoothness \
  dist/feature-xy/output.mp4 --lauf dist/feature-xy --json glaette.json
```

`--lauf` points at the output directory of a recording run. That is where
`motion-windows.json` and `timestamps.json` live; from them come the window
boundaries, the target distance and the window duration. **Only then do the two
external bounds carry any weight.**

Without `--lauf` the tool segments the movement itself. That is the fallback,
it appears as `fenster_quelle: eigene-zerlegung` in every output, and both
external bounds stay unchecked:

```sh
uv run --project tools/smoothness smoothness compare3-full.mp4 --panel 3/3
```

Print all knobs with their justification:

```sh
uv run --project tools/smoothness smoothness --erklaere-schwelle
```

## Options

| Option                | Meaning                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--lauf DIR`          | Directory with `motion-windows.json` + `timestamps.json`. Without it: the tool's own segmentation.                  |
| `--panel k/M`         | Panel `k` of a three-way comparison (960×540 below a 96 px header). Geometry of the `compare3` videos from the rig. |
| `--crop x,y,w,h`      | An arbitrary crop.                                                                                                  |
| `--fps`               | Frame rate of the output video. Without it, `fps_nominal` from `knobs.py`.                                          |
| `--aufnahme-breite`   | Width of the capture window in CSS pixels (default 2560, see `CAPTURE_SIZE` in `src/capture.ts`).                   |
| `--px-skala`          | Crop pixels per capture pixel, stated explicitly. Without it, derived — the provenance appears in every output.     |
| `--json FILE`         | The full report as JSON.                                                                                            |
| `--erklaere-schwelle` | Every knob with its value and justification.                                                                        |
| `--vergleiche JSON…`  | Order already-written reports from the same recording script from smooth to hitchy, over the windows judged in all. |

## What comes out

A readable report on the console; with `--json`, the same content in
machine-readable form. Per window:

- **Verdict** — `glatt` (smooth), `N Haker; schwerste Stelle: …` (N hitches,
  worst place), `unruhig (…)` (restless), `Teleport: …` or **`NICHT MESSBAR`**
  (not measurable) with a reason. A window whose external bound breaks **or
  stays unchecked** gives no smoothness verdict — without `--lauf` the target
  distance is missing, and then there are only measurements.
- **Severity** — the largest step in even steps (target distance ÷ frame pairs)
  and as a share of the travel. The hitch count alone ranks a teleport better
  than two small catch-ups.
- **Both external bounds** with `haelt: true | false | null`. `null` means _not
  checked_ and is not a pass.
- **Every ratio with its own denominator**, and what that denominator means in
  words. The repetition ratio divides by the window's frame pairs, the hitch
  ratio by the frame pairs of the travel — those are different numbers.
- **Direction kept separate.** Left and right are never averaged.
- **Scale with provenance**, so that "derived" never looks like "measured".

Up front there is a **summary**: windows judged and windows withheld with a
reason, hitches, teleports and the worst window, per direction.

If the tool finds no evaluable window at all, it says so explicitly — silence
would otherwise read like a pass.

## Tests

```sh
uv run --project tools/smoothness pytest            # everything, around 70 s with a warm cache
uv run --project tools/smoothness pytest -m "not langsam"   # without video generation, under 1 s
uv run --project tools/smoothness pytest -m langsam         # only the video cases
```

The calibration videos are generated on the first run (`ffmpeg` required) and
cached in `.eichvideos/`. To rebuild them:
`FEATURECAST_EICHUNG_NEU=1 uv run pytest`.

What the tests prove and where their inputs come from is stated at the head of
every test file — mutation, reachability, denominator, external anchor, fixture
provenance.

## Limits

In short: no colour, translation only (no rotation, no zoom, no cross-fade),
one moving object only, slow-motion files unusable, and the hitch threshold is
**not** calibrated against the owner's eye. In full and with reasons in
[`docs/SMOOTHNESS.md`](../../docs/SMOOTHNESS.md), section "Limits".
