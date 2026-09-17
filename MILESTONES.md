# Milestones

Every milestone has an acceptance criterion you can **run**. No milestone
counts as reached because the code exists — only because the criterion is
demonstrably met. The first two clear risks before anything is built;
everything after that is construction.

---

## M0 — Foundation

Repository, TypeScript, Playwright, formatting, an example script that does
nothing but open a page.

**Acceptance:** `pnpm demo:hello` opens a page and exits with code 0.

---

## M1 — The capture stands, and it looks good

Capture through `page.screencast`, frames with real timestamps, assembly to a
constant 60 frames per second through ffmpeg.

This is the risk milestone: every quality statement so far is a measurement,
**nobody has watched a result**. If a 2560 capture does not look convincingly
sharp after being scaled down to 1920, that changes the whole plan — which is
why it comes before everything else.

**Acceptance:** a capture of a real, dense application interface (not
`example.com`), 20 seconds with scrolling and transitions. `ffprobe` reports
1920×1080, a constant 60 frames per second, no duplicate frames. The result is
**watched** and compared with a Screen Studio recording of the same interface.
The verdict is recorded in writing.

---

## M2 — The wrapper: smooth motion and the event log

The `demo` wrapper around Playwright's page: `point`, `click`, `tap`, `type`,
`hold`, `scroll`. Every movement runs through the adopted motion mathematics
instead of through linear interpolation. Alongside it, `events.jsonl` is
written with the pointer track at 60 hertz, clicks and the bounding box of the
element that was hit.

**Acceptance:** two runs of the same script produce bit-identical
`events.jsonl` (repeatability). The pointer track has no jump over 20 pixels
between two sample points. Every click carries a bounding box that matches the
visible element.

---

## M3 — Getting mobile sharp

The exploratory milestone. The three routes described in
[PLAN.md](PLAN.md) are built, measured and watched; one wins, the others are
rejected with a reason.

Plus: touch instead of mouse in the wrapper (`page.touchscreen.tap`), a touch
ripple instead of the arrow in the render, and the question of whether the
capture works under WebKit or whether the iPhone profiles have to be driven
under Chromium.

**Measured and decided on 2026-09-15:** the frame route wins; five routes were
checked, four rejected, each with its number. The reasoning, the rejected
routes and what the route costs are in
[docs/M3-VERDICT.md](docs/M3-VERDICT.md). What remains open is WebKit alone —
the measurements were made under Chromium with the iPhone profile.

**Acceptance:** a 1080×1920 portrait video of a real mobile interface, watched
and judged fit for social media. Text at normal body size is legible. No mouse
pointer in the picture. The decision, including the rejected routes, is written
down in the repository.

---

## M4 — Post-processing: zoom, pointer, pace

Zoom spring and rest detection adopted and parameterised, pointer rendered
from the event log, idle passages compressed. Output in 16:9, 9:16 and 1:1 out
of the same raw material.

**Acceptance:** one raw video yields three formats without another browser run.
The zoom frames the element that was hit on every click and not a point beside
it. One look parameter is changed and the result is available again in under
two minutes.

---

## M5 — Device layer and configuration

The layering described in [docs/DEVICES.md](docs/DEVICES.md): Playwright's
registry read at run time, our own capture and output layer on top, eleven
presets, individual fields overridable.

**Acceptance:** the same unchanged script runs across four presets — desktop,
iPhone, Android, tablet — and produces four correctly formatted videos. An
unknown device name aborts with an error message naming the available names.

---

## M6 — Garage upload and one command for everything

Upload to S3-compatible storage, credentials from the environment, a URL
returned. One `featurecast` command that takes a script, devices and a target
and runs the chain through.

**Acceptance:**
`featurecast run demo/feature-xy.ts --devices desktop,iphone --upload` delivers
two retrievable URLs. The encode runs on the 3090 box; the run time for 30
seconds of 1080p60 is measured and recorded.

---

## M7 — Usable by other people

Documentation on how an existing Playwright script becomes a recording script.
Recipes for the usual stumbling blocks: signing in through a saved session
state, hiding cookie banners, freezing clocks and random data so that two
recordings look identical.

**Acceptance:** an existing Playwright script from another project is converted
into a recording in under 30 minutes, without anything in the wrapper itself
having to change.

---

## Not in the plan

Deliberately left out, so that it is clear it was not forgotten: a user
interface (the dropdown is prepared but will not be built), voice-over and
subtitles (the existing video pipeline does that), music, multilingual
recordings, and automatically detecting new features from pull requests — that
is an idea of its own for later.
