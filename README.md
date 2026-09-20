# featurecast

**Turn your Playwright script into a product demo video — filmed on twelve
devices, each in its own layout, and re-cut without ever reopening the
browser.**

One browser run produces clean footage and a log of where the pointer went,
what was clicked and which element it hit. Everything visible in the finished
video is decided after that, from the log: cursor, camera, pace, aspect ratio.
Changing any of it is a re-render of seconds, not another visit to the
application.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Every device, filmed as that device

![One script, three devices: desktop, tablet and phone, each in its own shape](docs/media/every-device-native.webp)

The phone video is not a crop out of the wide one. The browser is told it is a
phone before anything is filmed, so the application serves its phone layout —
bigger type, one column, a fingertip instead of a mouse pointer — and that is
what the camera sees.

```bash
pnpm featurecast run demo/fixture-tour.ts --devices desktop,tablet,iphone
```

|                          | A screen recording                | featurecast                                                  |
| ------------------------ | --------------------------------- | ------------------------------------------------------------ |
| How a phone shot is made | crop or shrink a desktop take     | the browser renders the phone layout                         |
| Portrait sharpness       | upscaled to fill 1080×1920        | native pixels, delivered at the size the capture can pay for |
| Touch                    | a mouse pointer on a phone screen | `page.touchscreen`, drawn as a fingertip                     |
| Device list              | whatever your display is          | twelve presets, plus every phone and tablet Playwright knows |

Twelve presets are ready to name and the rest of Playwright's registry works
too — [docs/DEVICES.md](docs/DEVICES.md) lists them. One take also yields
several shapes: `--all-formats` delivers 16:9, 9:16 and 1:1 without a second
browser run.

**A format is only delivered at a size the capture can pay for.** A 2560×1600
desktop capture does not contain a sharp 1080×1920 portrait frame — the largest
9:16 rectangle in it is 900×1600. featurecast delivers 900×1600 at full
sharpness and says so, instead of upscaling.

**4K is a preset, not a promise about frame rate.** `desktop-4k` records and
delivers 3840×2160 at 98.6 % yield, but the browser stops presenting sixty
frames a second at that size: the median gap between presented frames is
20.52 ms against 16.76 ms at 2560×1600. So: 4K, yes. 4K at 60, no.

---

## Measured against other recorders

Twenty open-source recorders were read for what their source can do; three
could run at all. All three filmed the same page on the same machine in the
same container, and every output — including ours — was then read with the same
instruments. Full method, evidence and the places it does not flatter us:
[docs/COMPARISON.md](docs/COMPARISON.md).

|                                       | Those three                   | featurecast                  |
| ------------------------------------- | ----------------------------- | ---------------------------- |
| Frames that carry a new picture       | 12–33 per second              | **37.5 per second**          |
| Frame rate written into the container | 30–60, none of them delivered | 60, also not fully delivered |
| Scroll a container sideways           | none of them can              | yes                          |
| Portrait                              | none, or upscaled 1.78×       | native crop                  |
| Aspect ratios from one take           | one, one, two                 | **three**                    |
| Changing the look                     | starts a browser              | **starts no browser at all** |

The point of the first row is not the ranking. A file can say sixty frames a
second while every other frame repeats its predecessor, and `ffprobe` will
still say sixty. The instrument that reads the picture instead of the header
ships with the repository — [tools/cadence/](tools/cadence/README.md) — and is
calibrated against five clips with a known answer.

---

## One take, every look

![The same take rendered three ways: no pointer, the default pointer, a bigger pointer](docs/media/one-take-every-look.webp)

Three versions of one browser run. The application behind them is the same
pixels at the same instant; only the pointer differs, because the pointer was
never recorded.

| Decision                      | In a screen recording        | In featurecast                       |
| ----------------------------- | ---------------------------- | ------------------------------------ |
| Cursor shape, size, ripple    | captured pixels              | drawn at render time, from the log   |
| Which element the zoom frames | captured pixels              | the logged bounding box of the click |
| Aspect ratio                  | fixed at capture             | 16:9, 9:16 and 1:1 from one take     |
| Idle passages                 | cut by hand                  | compressed from frame timestamps     |
| Changing any of the above     | record the interaction again | re-run the renderer                  |

![The frame pushes in on the button the pointer is about to press, then pulls back out](docs/media/camera-follows-click.webp)

Nobody framed that by hand. The camera moves in by cropping into the original
picture, never by blowing it up, so it goes only as close as the recording
stays sharp — and says so when you ask for more.

```bash
pnpm render artifacts/tour/desktop dist/tour --zoom 2.2 --padding 90
```

Scrolling is the other thing that gives a demo video away. A wheel moves a
page in lumps, one jump per notch, and at sixty frames a second a viewer sees
every one of them. featurecast covers the same distance in eased steps, never
more than 30 px between two frames.

![Wheel packets against eased steps, side by side, on a slice of a table](docs/media/scroll-steps.webp)

---

## Quick Start

Node 22 or newer, pnpm, and ffmpeg on the path.

```bash
git clone https://github.com/PhilflowIO/featurecast.git
cd featurecast
pnpm install
pnpm browsers:install
```

Record and render an example that needs no account and no network:

```bash
pnpm featurecast run demo/feature-xy.ts --devices desktop-wide
```

Record on a quiet machine with a GPU: the browser paints the page in real
time, and on a busy or GPU-less machine a scroll judders. `featurecast run`
refuses a software renderer; `tools/gpu-box/record.sh` runs the same command
on a GPU host and brings the clip back — see
[docs/RECORDING-SCRIPTS.md](docs/RECORDING-SCRIPTS.md#where-to-record-a-quiet-host-with-a-gpu).

Next to the recording you get a folder with the finished video and the
`decisions.json` that produced it. Restyle it without touching the browser:

```bash
pnpm render artifacts/feature-xy/desktop-wide dist/feature-xy \
  --padding 40 --cursor-size 32
```

Your own script becomes a recording script by exporting the body of the
recording and routing its interactions through `demo` instead of `page`:

```ts
import type { Demo, RecordPage } from '../src/record.js'

export const url = 'https://app.example.com'

export default async function featureXy(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/new-feature')
  await demo.point('#nav-settings') // smooth approach, no click
  await demo.click('#toggle-dark-mode')
  await demo.hold(1200) // let the effect land
}
```

Signed-in sessions, cookie banners and frozen clocks are covered in
[docs/RECORDING-SCRIPTS.md](docs/RECORDING-SCRIPTS.md).

Three finished recordings become one picture of the app on every device at
once — the shot a product page opens with:

```bash
pnpm montage desktop.mp4 tablet.mp4 phone.mp4 --out shot.mp4 \
  --device monitor --device tablet --device phone --still shot.png
```

---

## What you get today, honestly

Capture yield is the share of frames the browser presented that actually
reached the file.

| Browser                                         | Yield                                   |
| ----------------------------------------------- | --------------------------------------- |
| **The one `pnpm browsers:install` gives you**   | **98.8 %** (338 of 342, three of three) |
| Chromium 153, the bundle before Playwright 1.64 | **84–88 %**, and it fails the 95 % gate |

Measured on the benchmark machine, 2026-09-17, at 2560×1600 with the same tour
and three repeats per arm.

**The top row is what you get out of the box.** featurecast pins a Playwright
that ships a stock Chrome for Testing 154 — no patched build, nothing to
compile. `CHROME_BIN` still points a run at any other Chromium; one older than
154 records fine, it just lands in the second row.

**What changed, and why the number moves so much.** Chromium stops handing out
screencast frames once too many are unacknowledged, and its default bound of
three is too low for a 2560×1600 capture: the same run scores 82–90 % at three
and 98.8 % at twelve. Playwright's screencast wrapper cannot pass that bound at
all, so featurecast drives the recording over the browser protocol directly.
This used to require a self-built Chromium; since Chromium 154 it no longer
does. There is no second reason to build your own browser either: switching
off Chromium's `AnimatedContentSampler`, once blamed for judder in sideways
scrolling, changes nothing three instruments can see over nine runs
([docs/CAPTURE-CADENCE.md](docs/CAPTURE-CADENCE.md)).

**Yield is not cadence.** 98.8 % of presented frames reach the file, and 37.4 %
of the frames in the finished video still repeat their predecessor — the
capture's own timeline is the open problem, not the transport.

Status: pre-1.0, not published to npm, interfaces still move between
milestones. [MILESTONES.md](MILESTONES.md) lists what is accepted and what is
not, each with a criterion you can run yourself.

---

## Documentation

- **[docs/RECORDING-SCRIPTS.md](docs/RECORDING-SCRIPTS.md)** — turn an existing Playwright script into a recording
- **[docs/DEVICES.md](docs/DEVICES.md)** — the twelve device presets and how they resolve
- **[docs/COMPARISON.md](docs/COMPARISON.md)** — measured against three other recorders, and where it does not flatter us
- **[docs/INTERNALS.md](docs/INTERNALS.md)** — how it works in full detail
- **[docs/YIELD-BENCH.md](docs/YIELD-BENCH.md)** · **[tools/cadence/](tools/cadence/README.md)** · **[tools/smoothness/](tools/smoothness/README.md)** — measure it yourself
- **[PLAN.md](PLAN.md)** · **[MILESTONES.md](MILESTONES.md)** — architecture and acceptance criteria
- **[docs/CAPTURE-CADENCE.md](docs/CAPTURE-CADENCE.md)** · **[docs/SMOOTHNESS.md](docs/SMOOTHNESS.md)** — the measurement record

---

## Contributing

Pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Third-party code and its origins are listed in
[THIRD-PARTY.md](THIRD-PARTY.md).
