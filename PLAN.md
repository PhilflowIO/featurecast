# Plan

Everything claimed here is marked either **measured** (a command ran and its
output was recorded) or **assumed** (read from source or inferred, not yet
executed). The outputs themselves were in a research report from September
2026 that lives outside this repository and is not mirrored here — from here it
is therefore not verifiable. What is verifiable is what has been measured in
the repository itself since: the milestone reports under [docs/](docs/).

---

## The decision in one paragraph

No existing open-source tool satisfies capture quality, smooth mouse motion
and mobile at the same time — all of them burn cursor and zoom into the pixels
and capture at too low a bitrate (measured: 215 kbit/s for
`45ck/demo-machine`, VP8 1280×720 at 25 frames/s; measured on static content,
so not directly transferable to a dense, animated interface). We are therefore
not building a new application but a thin layer around Playwright, adopting
from four third-party repositories exactly the parts that are demonstrably
good there: the motion mathematics, the zoom spring, the event format and the
idea of two separate artifacts. The rest — device resolution, render, Garage —
is our own code, because it exists in none of those repositories.

---

## Architecture

```
Playwright script (yours)
        │  interactions run through the demo wrapper
        ▼
┌─ Capture ───────────────────────────────────────────────┐
│  page.screencast  →  frames/*.jpg + timestamps           │
│  demo wrapper     →  events.jsonl                        │
│     (pointer track 60 Hz, clicks, target bounding box)   │
└──────────────────────────────────────────────────────────┘
        │   two artifacts, nothing burned in
        ▼
┌─ Post-processing (parameterised, no browser) ───────────┐
│  Zoom curve  spring from the events → crop per frame     │
│  Pointer     arrow or touch ripple, rendered afterwards  │
│  Pace        idle passages are compressed                │
│  Format      16:9 / 9:16 / 1:1 from the same material    │
│  Encode      ffmpeg, NVENC on the 3090 box               │
└──────────────────────────────────────────────────────────┘
        ▼
   Garage (S3-compatible)  →  URL
```

Every stage can be invoked on its own. Capture and render are separate
commands, so that changing the look costs no new browser run.

---

## The three open questions from the conversation

### 1. What makes the mouse motion smooth?

Two things that have to be kept apart.

**How the real pointer moves** (this drives what the app experiences — hover
states, drag, `mousemove` handlers): Playwright's
`mouse.move(x, y, {steps})` interpolates linearly, which looks mechanical. We
replace the path with a curve that accelerates and brakes, overshoots slightly
just before the target, and carries a minimal tremor. The best implementation
found is `matinee/src/motion.ts` (MIT): minimum-jerk velocity profile,
two-phase approach, tremor from two incommensurable sines, and the randomness
is derived from a seed — so two runs produce the same video, which matters for
repeatability at every release. That is read, not measured.

**How the pointer looks in the video**: not through the browser at all.
Headless Chromium renders no pointer whatsoever (measured), and a fake cursor
injected into the DOM lives inside the foreign page's stacking context — it
disappears behind overlays, inside canvas areas and iframes. We therefore draw
the pointer in post-processing from the event log. A side benefit: pointer
size, shape, click ripple and highlighting are render parameters, not capture
properties.

Rejected: `ghost-cursor`, the best-known library. Its curve is good, but by
default it delivers only around 33 support points with jumps of up to 167
pixels (measured) and never waits between the points — the duration of a
movement depends on the network latency to the browser and is not
controllable. Unusable for video.

### 2. Mobile — without a mouse, with touch

Yes, the browser emulates this completely, and more than just the window size:
Playwright sets `isMobile`, `hasTouch`, the device pixel ratio and the user
agent per device, so that media queries, touch events and
`@media (hover: none)` genuinely take effect. Instead of `click()`, the
interaction runs through `page.touchscreen.tap()`, and in the video a blooming
touch ripple replaces the arrow. The `demo` wrapper decides this automatically
from the device profile — the same script runs desktop and mobile, with no
branch in the script.

**The unsolved part — solved since 2026-09-15, see
[docs/M3-VERDICT.md](docs/M3-VERDICT.md):** the capture delivers CSS pixels and
ignores the device pixel ratio (measured — a requested pixel ratio of 2 still
came out as 1280×800). An iPhone 15 Pro is 393 CSS pixels wide. An untreated
capture would therefore be 393 pixels wide and useless for social video. Three
routes were on the table here; M3 measured five:

- **Frame trick** — **won.** Load the app in a 393 pixel wide frame inside a
  large page and display the frame scaled up via CSS: the app still sees 393
  pixels of layout width, and rasterisation happens at 1080. The two risks
  named here both materialised and both are fixed — the shell is served from
  the application's own origin, which satisfies `X-Frame-Options` and lets the
  app keep its storage; the only thing that has to be converted is the wheel
  delta.
- **Screenshot capture** — rejected. `Page.captureScreenshot` is indeed
  pixel-ratio-faithful, but delivers **8.8 frames per second** as soon as
  anything on the page moves. Even for a calm demo that is not video.
- **Upscaling in the render** — rejected without measurement: moot after the
  frame trick.

### 3. Devices as a parameter

We are not inventing a table but using the built-in one: Playwright supplies
**143 device profiles** (measured) with viewport, pixel ratio, touch capability
and browser engine. Over that we lay a small layer of our own — what is
missing for filming: capture resolution, output format, pointer style, frame
rate, encoder quality. A device is then a name in the invocation, a line in a
configuration file, and later, with no further work, an entry in a dropdown.
Details and the curated shortlist in [docs/DEVICES.md](docs/DEVICES.md).

---

## What we adopt instead of building

All four are MIT-licensed and therefore adoptable. Adopted files keep their
licence header and are listed in `THIRD-PARTY.md` with source and commit.

| From                                      | What exactly                                                         | Why not build it ourselves                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benhowdle89/matinee`                     | `src/motion.ts` — minimum-jerk motion, overshoot, tremor, seeded     | The best motion mathematics found, framework-free and already parameterised by frame rate                                                                                                                                                                                        |
| `pythonlearner1025/Screen-Studio-Effects` | `spring.ts`, `zoom.ts`, `auto-zoom.ts` — zoom spring, rest detection | Measurably smooth curve (max. 0.024 change per frame at 60 fps), solved analytically instead of integrated, so reproducible independently of frame rate. **Careful:** a hard-wired factor 2 in `cursor.ts:45-46` has to be parameterised on adoption; no tests in the repository |
| `connerkward/screenstudio-alt-skill`      | Event schema including `bbox`, idle compression, 9:16 logic          | The `bbox` field frames the zoom on the real element instead of on a point — and Playwright supplies that box for free                                                                                                                                                           |
| `smallstack/playwright-marketing-videos`  | A pattern for getting started with `page.screencast`                 | The only repository that uses the new capture interface at all                                                                                                                                                                                                                   |

From `45ck/demo-machine` we adopt only the pattern of cleanly separating raw
video and event file, no code — the 215 kbit/s measured above is the
disqualifying reason, and it cannot be cured without replacing the recorder.

---

## Settled technical decisions

**Capture through `page.screencast`**, not through `recordVideo`. Measured:
60.0 frames per second at freely chosen quality, against `recordVideo` at 25
frames of which only 121 of 173 differed at all.

**Desktop is captured oversized** (2560×1600 CSS pixels) and scaled down to
1920 in the render — all three desktop presets, without exception
([docs/DEVICES.md](docs/DEVICES.md)). On mobile this explicitly does **not**
apply: there the capture area is the output area, because doubling the area
halves the frame rate (measured,
[docs/M3-VERDICT.md](docs/M3-VERDICT.md)). It is the only route to sharp text,
because the capture ignores the device pixel ratio. The margin beyond that is
not a side effect but the precondition for M4: several output formats from
**the same** raw material without a second browser run, and a zoom spring that
travels around inside the capture instead of upscaling. Out of 2560×1600,
16:10, 16:9 and 1:1 fall out sharp; **9:16 does not** — that belongs to the
mobile presets (M3).

**Zoom is a crop out of the original, never an enlargement.** That is exactly
what the 1.33× capture reserve on the desktop exists for.

**No virtual time.** The `timecut` approach freezes the clock and breaks on
CSS transitions and backend latency in doing so (measured: a one-second
animation ran over 0.37 seconds). Unusable for a modern app.

**Encode on the 3090 box.** The checked post-processing chain takes 1 minute 45
for 8 seconds of 1080p60 on CPU (measured). That is the reason for NVENC, not
convenience.

**Garage from the start**, not retrofitted: upload as a stage of its own with
credentials from the environment, and a URL as output. No tool we checked
brings that with it.

---

## Open risks

- The recommended chain has been measured in two halves, never as a whole. The
  transition from the capture events into the zoom stage is the most likely
  breaking point.
- Not a single recording has been **watched** so far. All quality statements
  rest on measurements. Whether 2560 scaled down to 1920 really looks
  high-quality is for M1 to decide.
- All measurements ran against test pages, never against a real, dense
  application interface. Bitrates on a white background say little.
- Mobile in sharp quality is unsolved (see above) and could in the worst case
  come down to upscaling.
