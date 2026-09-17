# Measuring capture yield

Capture yield is the share of frames the browser presented that actually
reached the file. It is the number every claim in
[CAPTURE-CADENCE.md](CAPTURE-CADENCE.md) and in the README's honesty section
rests on, and this is the harness that produces it.

```bash
pnpm yield-bench demo/fixture-tour.ts --device desktop --capture 2560x1600 --passes 2
```

## What it measures, and what it refuses to do

Frames written to disk, divided by the frames Chromium reports it presented.
The denominator is Chromium's own trace, not an in-page counter — see
`src/presented.ts` for why, and `src/efficiency.ts` for the ratio and its 95 %
gate. Neither is reimplemented here; this file is wiring.

The whole recording is tiled into fixed windows, so idle passages count too.
Nothing is cherry-picked, and a run that spends half its time waiting cannot
flatter itself.

## Options

| Option          | Default                | What it does                                    |
| --------------- | ---------------------- | ----------------------------------------------- |
| _(positional)_  | `demo/fixture-tour.ts` | the recording script to drive                   |
| `--device NAME` | `desktop`              | any preset or Playwright device name            |
| `--capture WxH` | `2560x1600`            | the area to record                              |
| `--passes N`    | `1`                    | drive the script N times inside **one** capture |
| `--windowMs N`  | `1000`                 | width of the tiled windows                      |
| `--out DIR`     | `artifacts/yield`      | where capture and video land                    |
| `--render WxH`  | _(off)_                | also render a video afterwards                  |

**`--passes` is a requirement, not a convenience.** `resolveRefreshHz`
(`src/presented.ts`) will not bound the denominator until it has 150 gaps inside
the 5-30 ms band, and one run of `demo/fixture-tour.ts` lands at about 140. At
2560×1600 desktop, two passes clear it; the phone paths need far more (thirteen
were used for the 4K and phone measurements) because each pass is shorter.
Between passes the script's own `prepare` runs again with `localStorage`
cleared, so every pass starts from the same state.

## Which browser it measures

Whatever `CHROME_BIN` points at; without it, the Chromium that ships with
Playwright.

```bash
CHROME_BIN=/path/to/chrome pnpm yield-bench demo/fixture-tour.ts --passes 2
```

This matters more than it looks. `src/browser.ts` verifies through
`/proc/<pid>/exe` which binary actually started, and writes its path, version
and SHA-256 into `browser.json` next to the capture — because two builds of the
same Chromium version report the same version string, and attributing a
measurement to the wrong one has already cost this project three days.

Hardware GL is forced and asserted: a silent fallback to software rendering
still produces a technically valid video at a much lower real frame rate, so
`assertHardwareRenderer` fails the run instead.

## Reading the output

```
browser: /crbuild/chrome (Chromium 153.0.8010.12; requested: CHROME_BIN)
capture area: 2560x1600, strategy screencast, fps 60, jpeg q90
renderer: ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL ES 3.2)
DIAG presentedInstants=342 capturedFrames=338 sessionMs=31204 paintTicks=0
RESULT capture=2560x1600 device=desktop efficiency=98.8% captured=338 presented=342 refreshHz=59.96 ...
GATE pass (>=95%, denominator checks clean)
```

`RESULT` is the answer, `GATE` applies the 95 % floor and the denominator's own
sanity checks. `DIAG` is there to catch a run that measured nothing:
`paintTicks=0` is normal whenever the script navigates (navigation wipes the
in-page probe) and is not part of the gate.

`GATE fail` does not stop the run — the numbers are still written, because a
failing measurement is a measurement.

## What it leaves behind

Under `--out`, in `capture/`:

| File                      | What it holds                                       |
| ------------------------- | --------------------------------------------------- |
| `capture-efficiency.json` | the overall numbers and every window                |
| `presented.json`          | the denominator, so it can be re-checked afterwards |
| `timestamps.json`         | the capture manifest                                |
| `browser.json`            | which binary produced this, with its hash           |
| `frames/`                 | the captured JPEGs                                  |

With `--render`, the video lands in `video/`.

## Making the result mean something

A single run is a data point, not a result. The measurements this project
publishes use three repeats per arm, and when several arms are compared they are
interleaved per repeat rather than run arm by arm, so machine drift hits all of
them equally. Run one arm at a time: two captures sharing a machine measure the
machine.

And check the instrument against something outside itself. A harness that
reports plausible numbers for a configuration whose answer is already known
elsewhere is evidence; one that has never been pointed at a known answer is not.
