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

| Option                             | Default                | What it does                                    |
| ---------------------------------- | ---------------------- | ----------------------------------------------- |
| _(positional)_                     | `demo/fixture-tour.ts` | the recording script to drive                   |
| `--device NAME`                    | `desktop`              | any preset or Playwright device name            |
| `--capture WxH`                    | `2560x1600`            | the area to record                              |
| `--passes N`                       | `1`                    | drive the script N times inside **one** capture |
| `--windowMs N`                     | `1000`                 | width of the tiled windows                      |
| `--framesInFlight N`               | `12`                   | frames the browser may have outstanding         |
| `--framesInFlight browser-default` | —                      | measure whatever the build compiled in          |
| `--out DIR`                        | `artifacts/yield`      | where capture and video land                    |
| `--render WxH`                     | _(off)_                | also render a video afterwards                  |

**`--passes` is a requirement, not a convenience.** `resolveRefreshHz`
(`src/presented.ts`) will not bound the denominator until it has 150 gaps inside
the 5-30 ms band, and one run of `demo/fixture-tour.ts` lands at about 140. At
2560×1600 desktop, two passes clear it; the phone paths need far more (thirteen
were used for the 4K and phone measurements) because each pass is shorter.
Between passes the script's own `prepare` runs again with `localStorage`
cleared, so every pass starts from the same state.

**`--framesInFlight` is the single largest lever on the number this harness
reports**, which is why it is an option rather than a constant: at Chromium's
own default of 3 the same run scores 82-90 %, at 12 it scores 98.8 % three
times out of three. See [CAPTURE-CADENCE.md](CAPTURE-CADENCE.md).

## Which browser it measures

Whatever `CHROME_BIN` points at; without it, the Chromium that ships with
Playwright.

```bash
CHROME_BIN=/path/to/chrome pnpm yield-bench demo/fixture-tour.ts --passes 2
```

**A browser older than Chromium 154 is refused unless you say otherwise.** `maxFramesInFlight`
does not exist there, so the bound in force is whatever that build compiled in —
worth eleven points, i.e. more than most differences anyone comes here to look
for. Recording on such a browser is fine and the product does it; reporting a
yield number from one as though the regime were known is not, so the harness
stops before it prints anything.

`--framesInFlight browser-default` lifts that refusal, and the run then carries
`framesInFlight=browser-default` in its `RESULT` line together with the first
twelve characters of the running binary's SHA-256. Both are needed: the word
names the _kind_ of regime, the hash names _which_ one — a patched and an
unpatched build compile in different bounds and report the same version string.

The switch exists because some questions can only be asked of an older
browser: the README's comparison row is Chromium 153, which has no
`maxFramesInFlight` parameter to satisfy the guard with. The guard is against a
_silent_ unknown regime, not a named one.

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
browser: /pwb/chromium-1246/chrome-linux64/chrome (Google Chrome for Testing 154.0.8037.0; requested: playwright-bundle)
capture area: 2560x1600, strategy screencast, fps 60, jpeg q90
renderer: ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL ES 3.2)
DIAG presentedInstants=342 capturedFrames=338 sessionMs=31204 paintTicks=0
RESULT capture=2560x1600 device=desktop efficiency=98.8% captured=338 presented=342 refreshHz=59.96 medianGapMs=16.76 singleRefresh=84.8% doubledRefresh=6.7% ... framesInFlight=12
GATE pass (>=95%, denominator checks clean)
```

`RESULT` is the answer, `GATE` applies the 95 % floor and the denominator's own
sanity checks. `DIAG` is there to catch a run that measured nothing:
`paintTicks=0` is normal whenever the script navigates (navigation wipes the
in-page probe) and is not part of the gate.

**The yield is not the frame rate.** `medianGapMs`, `singleRefresh` and
`doubledRefresh` say how often the browser put a new picture on screen at all:
the median gap between presented frames, and the share of gaps that are one
refresh long or two. A page that moves on every refresh shows about 16.7 ms and
a large single share; one that moves on every second refresh shows 33.3 ms and
a large doubled share — and both can clear the gate at 98 %. Every phone
recording did exactly that until issue #116 was found, which is why the
cadence is printed beside the yield rather than trusted to it. The bands are
fractions of the measured refresh, so the numbers mean the same on a 120 Hz
display.

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
