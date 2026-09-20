# How featurecast works

Until 2026-09-17 this document was the repository's README. It is the inner
report: how capture and post-processing work, which guarantees hold and what
backs them. It is deliberately unabridged. The entry point for newcomers is
[README.md](../README.md).

---

A Playwright script becomes a marketing video of a feature — on desktop and
mobile, with soft, human-looking cursor motion and automatic zoom onto
whatever is happening at the time.

The core of the idea: **the capture burns nothing into the pixels.** Two
artifacts come out of it — a clean raw video and an event log (where the
pointer went, what was clicked and when, which element it hit). Cursor, zoom,
labels and aspect ratio are all added afterwards. Changing the look is
therefore a ten-second re-render, not another browser run.

The repository's target is your own Playwright scripts: an existing script
becomes a recording by routing its interactions through a wrapper that smooths
motion and logs it.

```ts
import { record } from 'featurecast'

await record(
  { device: 'iPhone 15 Pro', out: 'dist/feature-xy' },
  async (page, demo) => {
    await page.goto('https://app.example.com/new-feature')
    await demo.point('#nav-settings') // smooth approach, no click
    await demo.tap('#toggle-dark-mode') // click or tap, depending on the device
    await demo.hold(1200) // let the effect land
  },
)
```

Status: M0 and M2 are implemented — TypeScript, Playwright, formatting, a
smoke demo and the `demo` wrapper with its event log all run. The capture and
render stages follow in the later milestones. [PLAN.md](../PLAN.md) describes
the architecture and the decisions behind it, [MILESTONES.md](../MILESTONES.md)
the goals in order, [DEVICES.md](DEVICES.md) the device concept.

An existing Playwright script is converted into a recording in
[RECORDING-SCRIPTS.md](RECORDING-SCRIPTS.md) — including the recipes for
signing in through a saved session state, cookie banners and frozen clocks.

## Event log v1

`record({ device?, out, seed? }, async (page, demo) => ...)` wraps a `demo`
object (`point`, `click`, `tap`, `type`, `hold`, `scroll`) around Playwright's
page and writes a canonical, versioned `events.jsonl` beside it. Every line
has a fixed field order; the file always ends with a newline. Two runs of the
same script with the same `seed` produce bit-identical files — proven against
a real headless Chromium in `tests/record.browser.test.ts`.

Every movement runs through the minimum-jerk curve adopted from `matinee`
(acceleration, braking, slight overshoot, tremor) rather than through linear
interpolation, and is played to the page at a real 60 frames per second: every
pointer sample waits for its absolute point in time (start + i/60 s), not for
an accumulated pause, so no timing error can add up. Two neighbouring pointer
samples are never more than 20 pixels apart — that is a guarantee, not a
probability: `src/motion.ts` starts from an analytically derived sample count
and raises it deterministically until the actually rendered, rounded curve
holds the limit (same seed, same result). On long movements this costs
noticeable time — 1500 pixels really do take about 3.2–4.1 seconds, well above
`matinee`'s unconstrained 1.1 seconds, because its pace was never designed for
a 20-pixel limit. `hold(ms)` genuinely holds the page still for the given
time, instead of merely advancing the log. `type(target, text)` travels to the
field with the pointer, focuses it by click or tap (depending on the device),
and then types real keys with a seed-dependent delay per character.

Before a `point`/`click`/`tap`/`type` travels to a target, its geometry is not
taken from a single snapshot but sampled frame by frame across an observation
window (`requestAnimationFrame` inside the page, one round trip per window — a
browser recomputes the value of a CSS animation only once per render tick, so
any denser query returns the same frozen value). Three cases are distinguished
from those frames, in the order in which they are cheapest to detect.

**Still.** Every frame of an 80 ms window reports exactly the same edges —
bit-identical, no tolerance. This is the normal case and costs exactly one
window. The absence of tolerance is deliberate: `getBoundingClientRect()`
returns sub-pixel values, so a target that is still moving reports different
numbers from frame to frame, and a threshold of half a pixel waved through a
widening of 0.05 px per frame as "standing still" for exactly that reason. The
limit is no longer a chosen value but the browser's own sub-pixel
quantisation (Chromium: 1/64 px) over the window duration — around 0.2 px/s at
80 ms, arithmetically. **What is proven is 3 px/s**
(`tests/settle-criterion.browser.test.ts`): a target that grows exactly that
slowly for three seconds is waited out and logged with its final width. The
arithmetic lower bound below that is not backed by a test.

**Finite animation.** It ends at some point and leaves a genuinely still
element behind, so the code simply keeps observing window after window until
one of them is still. An animation of duration D therefore costs roughly D,
not a multiple of it — an ordinary 4-second transition stays inside the
5000 ms default budget, which is the value that was chosen for it.

**Permanent, bounded animation.** A pulsing CTA, a bounce, a wobble around
some `transform-origin`, a rotation: it never stops, so waiting would
inevitably run into the timeout. Instead its period is determined — read
through the Web Animations API, never set, and read on the element, on its
subtree **and on all its ancestors** (an animation on the parent node moves
the target but does not appear in the target's own `getAnimations()`); with
`alternate` the doubled iteration duration counts, and with several animations
their least common multiple. Every period obtained this way is then **verified
against the measured geometry**: what the page declares is a proposal, what
the box actually does is the decision. If no defensible period is found, one
is estimated from the measurements themselves; if that too comes to nothing,
`record` aborts after `settleTimeoutMs` with a message that says exactly that
(the target moves within bounds but without a measurable period), instead of
quietly averaging over an arbitrarily long window.

The measurement then runs over an **integer number of periods**, and that
number is a pure function of the period (`ceil(480 ms / period)`) — not of
elapsed time, not of the remaining budget, not of the number of previous
windows. Exactly that dependency was the reason two runs of the same script
logged different boxes: a run that needed one more observation round averaged
over a differently phased window. Every frame enters weighted by the time
until the next one, the last frame only by the time remaining in the window —
the result is a true time integral over the period count, not an average over
however many frames the machine happened to manage. Under load, where
`requestAnimationFrame` collapses from 60 Hz to a handful of frames, that is
the difference between a stable answer and one that follows the load.

The logged box is the **longest-held** (most frequently occupied) box, provided
one clearly dominates — for an animation with a rest phase, "resting geometry"
means the box the element actually sits in, not the mean of rest and brief
excursion. An animation that spends 70 % of each cycle at `scale(1)` and
briefly swings out to 1.6 would, averaged, yield a box the element never
occupies, and M4 would zoom onto exactly that. Where no box dominates (a
steadily traversing motion with no resting position), the period-accurate time
average is the answer. The interaction point is the centre of that resting
box, pulled into the region the target covered in **every** observed phase — a
click therefore lands at any point in the animation. The centre of that
intersection region would itself be unsuitable: its edges are the extremes of
the animation, and a process can in principle only hit an extreme to within one
render frame — which is exactly where the remaining one-pixel difference
between two processes came from.

Two separate processes therefore log the same box and the same point:
`tests/settle-determinism.test.ts` starts three of its own processes per case
and compares `sha256(events.jsonl)` — **and does so under load** (32 compute
loops in the same container, adjustable via `FEATURECAST_LOAD_WORKERS`),
because the guarantee looked green on an unloaded machine even when it did not
hold. On the benchmark machine: ten repetitions, three processes per case,
three cases (pulse, bounce, asymmetric rest phase) — every run green, and the
hashes identical across all repetitions, not merely within one run. The
measured limit lies above that: at 96 compute loops on 32 cores (triple
oversubscription) the browser delivers so few render ticks that no period can
be verified any more — and then **the recording aborts with the
`settleTimeoutMs` message**, in three runs without exception and never with
diverging hashes. That is the right outcome: better no log than a wrong one.
This costs something, and the cost can be named precisely: a single click on a
static page takes 1479 ms against 1362 ms on `main` (+8.6 %), ten interactions
7038 ms against 6026 ms (+16.8 %, so around 101 ms per interaction), each the
mean of three runs on the benchmark machine (`demo/settle-cost.ts`). The
surcharge is almost entirely the second observation window after arrival — the
price of _measuring_ the logged box on arrival rather than reading it off once.

All of this is independent of whatever moved the geometry: native window
scrolling, an `overflow:auto` container, or a JavaScript-animated transform
(Lenis-style scrolling) that never touches `window.scrollX/Y`. `scroll(dx, dy)`
itself does not wait for it — it does not know its target — but the next
interaction does. If the geometry fails to settle for too long, `record`
aborts after `settleTimeoutMs` (default 5000 ms, adjustable via
`RecordOptions.settleTimeoutMs`) with an error message that names the option.
That budget applies per interaction, not per measurement: every interaction
resolves the geometry twice (before travel and after arrival) and both share
the same deadline — previously a single interaction could consume double the
budget, measured at 125 s with a setting of 60 s.

Because the approach itself can take from 0.4 to over 4 seconds, "the geometry
was stable at the start" is not enough on its own: the target can move,
re-render, change size or be occluded by something else in the meantime. The
interaction is therefore self-verifying. Before the movement, the actual
interaction point is checked against the live page — which element really lies
at these coordinates (`document.elementFromPoint`)? What is checked first is
exactly the point determined above, the centre of the resting box: if it is
free, it is the interaction point — the common, cheap case, a single check. If
it is occluded (a sticky header, or two overlays from opposite sides), a
deterministic grid of probe points across the whole visible area finds the
largest contiguous free region and picks the point nearest its centroid —
rather than nine fixed spots at edges and corners, which systematically missed
a free zone somewhere in between (between two overlays, say). The spacing
between two probe points is a fixed, size-independent value (6 px) instead of
an average that grows coarser with the target: the _number_ of probe points
grows with the target, not their spacing, so a 6 px free strip on a 300 px
target is found just as reliably as a 30 px strip on a 1200 px hero. Two runs
against the same occlusion pick the same point — proven across three separate
processes via `sha256(events.jsonl)`
(`tests/occluded-target-determinism.test.ts`). This costs something, and only
in the occluded case: on a screen-filling hero (1280×720 visible area, around
26,000 probe points in one round trip) 1.86 s per interaction was measured on
the benchmark machine (4.28 s against 2.43 s for the same hero without
occlusion, each the mean of three runs); if that first point is free, the grid
falls away entirely. After arrival the geometry is resolved completely afresh
— not only when something looked suspicious, because a target can grow around
the same centre and never fail the hit test while doing so. Whether a second,
equally pixel-limited movement leg is needed for that is decided solely by a
hit test at the current pointer position: "would a click here hit the target
now" is a yes/no question that a pixel of measurement noise cannot flip —
which is why no tolerance constant is needed for it any more. The logged
bounding box is the resting geometry determined on arrival, never a single raw
reading immediately before the click: on an animated target such a reading
returns exactly the phase that one round trip happened to catch — the wrong
box, and a different one in every process. If the hit test after arrival
notices a change, everything is resolved afresh. If verification fails,
`record` aborts with an error message instead of guessing. This is a very
strong guarantee but not an absolute one: between the last check and the
actual `page.mouse.click` there is still a single network round trip in which
the page could theoretically change one last time — that window is
deliberately kept small (one evaluate call instead of the full 0.4–4 seconds
of approach) but it is not reduced to zero. A plausible-looking click that
never executed is nonetheless this tool's worst failure case: milestone M4
would later zoom onto an event that never happened.

`tick` is the planned 60 Hz time-slot index, not real time, but a continuous
time scale: everything that consumes planned time advances it. Pointer samples
raise it by one per sample — even a sample that lands on the same pixel as its
predecessor (the pointer briefly "holds") is logged and counts a slot.
`hold(ms)` advances it by `ceil(ms / 1000 * 60)`, `scroll` by one slot per
60 Hz wheel increment, and `type` by the sum of the (seed-dependent, hence
deterministic) character delays in slots. **What `tick` does not know:**
everything that costs real time without being planned itself — `page.goto`,
every `boundingBox()` measurement including the wait loop for stable geometry
and the verification hit tests, the round-trip time of a click. `tick` and the
wall clock therefore drift apart: measured in this session at around +14–15 %
for an ordinary script (click, type, hold, scroll, click), and around 1.3× for
a script with a slowly animating inner scroll container — depending on the
page's animation it can be considerably more. The self-verification above did
not measurably worsen that figure in this session (the extra checks are small
against the several-hundred-millisecond pointer movement that happens anyway).
This is not a bug but the open edge of this milestone: mapping `tick` onto the
real capture clock belongs to ticket 9, which needs exactly this uniformity of
`tick` in order to work.

A target whose bounding box has no visible intersection with the viewport at
all makes `record` abort with an error message that points at `demo.scroll` —
scrolling automatically would build an invisible jump into the video. If the
box is larger than the viewport (a tall hero area, an overlay) or partly
occluded by something else (a sticky header), there is no abort: the probe-point
search described above finds the visible, genuinely clickable spot, and the
full bounding box still goes into the log. Only when none of the probe points
hits does `record` abort.

`device` is already resolved against Playwright's device registry, among other
things for `hasTouch`, so that `tap` runs in a real touch context instead of
crashing. An unknown name aborts with an error message naming similar or
available names. The curated preset layer above it (capture/output format,
pointer style) follows in M5.

## Post-processing: zoom, pointer, pace, formats

`pnpm render <recording-folder> <target-folder>` turns a raw recording into
finished videos. It starts no browser and cannot start one: its inputs are the
frames the capture wrote and the event log beside them. A different pointer, a
different zoom, a different aspect ratio is therefore another run of this
command, not another run of the script.

```sh
pnpm render artifacts/m1-008 dist/feature-xy
pnpm render artifacts/m1-008 dist/feature-xy --padding 40 --cursor-size 32
```

16:9, 9:16 and 1:1 all come out of the same raw material. **Zoom is always a
crop out of the original, never an enlargement** — and that has a consequence
most tools keep quiet about: a 2560×1600 desktop capture does not contain a
sharp 1080×1920 portrait frame. The largest 9:16 rectangle inside it is
900×1600. The renderer then delivers 900×1600 at full sharpness and says so in
its output, instead of upscaling. A sharp portrait frame comes from capturing
in portrait, and that is M3.

No zoom does not mean no pan, though. A 900 pixel wide window can sit anywhere
in a 2560 pixel wide capture, and moving it costs nothing — it is still the
same crop out of the original. Portrait therefore follows the clicked element
sideways, on the same spring as everything else, instead of never showing 65 %
of the interface as a frozen centre strip. The same holds for 1:1. 16:9
already fills the width of the capture and does not change as a result; that
it is cropped at the top rather than centred remains a deliberate decision —
navigation bars and toolbars live exactly there.

On a click, the zoom frames the bounding box of the element that was hit. That
box is the element's **resting position**, not its geometry in the frame the
click landed in: for an element that fades in or pulses, it is the geometry it
spends longest in — not the mean of its extremes, because for an asymmetric
animation the mean is a size the element has in no single frame. The crop
therefore stands still while the element breathes, and is never widened after
the fact.

If two interactions follow each other more closely than the camera needs to
travel, **hold and approach** share the time between the two events: if it
suffices for both wishes, each gets its own, otherwise both give way
proportionally — with the default values (900 ms hold, 650 ms approach) 58 %
of the gap goes to the hold. The earlier shot is never ended before its own
click — otherwise the frame at the moment of the click would show a point on
the way to the next element instead of the element that was clicked, and with
two targets on opposite sides the clicked element would not be in frame at
all. If the hold had to be shortened, the renderer says so in its output
instead of quietly collapsing the shot into a single frame.

Two interactions at the **same instant on the same element** are a single
shot: the camera frames the element and holds across both events. That is the
normal case, not a special case — a switch toggled twice or a counter pressed
twice land on the same time slot in the event log, because `click` does not
advance the counter and a movement onto a target the pointer is already on
produces no samples. Because both boxes are the same, the framing of the shot
is bit for bit the framing of each individual event.

Two interactions at the same instant on **different** elements make the
renderer abort — there is no camera for that — and it names the remedy that
helps today: a `demo.hold(…)` between the two. Overlapping elements are
different elements too: framing both together would mean their union, and the
union of an icon inside a page-filling area is the whole page — a "zoom" that
does not move.

The renderer also aborts when there is too little time between two
interactions to carry the camera across honestly: holding the first shot needs
at least one frame, approaching the second at least eight. A gap that pays for
neither is a cut, not a camera move.

The camera never cuts: in no single output frame does it cover more of its
path than the spring it rides on covers in its fastest frame over the shortest
permitted approach — 42.6 % of the path. Ordinary movement stays well below
that (9.2 %), the tightest in the corpus at 33.1 %. The bound deliberately
reads nothing from the shot it is judging: a bound computed from the shortened
window itself compares the movement with itself and lets everything through.
In addition: a shot begins exactly where the camera already stands, and across
the seam between two shots there may lie only as much movement as the previous
shot's exit produces itself. Paths under 16 source pixels are not a camera
move and are not judged — a purely relative bound with no absolute floor
rejected a valid recording in all three formats in round four.

This is not a test promise but an assertion in the renderer itself: a shot
list that violates it does not leave `buildZoomSegments`.

The pointer and click ripple are drawn here, not captured: headless Chromium
renders no pointer at all, so the log is the only source. Size, shape and
ripple duration are parameters.

Idle passages are compressed. The signal for that is the capture's own
timestamps: the capture already folds bit-identical consecutive frames
together, so a large gap between two surviving frames is a stretch in which
the picture did not change — not merely an animation tick without a repaint.
Compression runs through a single, strictly monotonic time mapping through
which frames and events pass together; they therefore cannot drift apart.

The core is a pure function from (events with a time in milliseconds, frame
timestamps in milliseconds) to crop rectangle and pointer draw list per frame.
That decision data lands as `decisions.json` beside the video.

**Same decision data, same video — byte for byte.** Cropping, scaling and
drawing the pointer happen frame by frame in our own code, not in ffmpeg's
filter graph. ffmpeg keeps the jobs it is good at — decoding, encoding, time
base — and loses the one it was unreliable at: setting a different geometry
per frame. Through a time-driven command channel (`sendcmd`) that was not
reproducible: six identical runs over the same command file produced four
different videos, with wrongly framed stills and a pointer that did not follow
what `decisions.json` says. Now there is nothing left between decision and
pixel that could come out differently from run to run; six runs in six
processes yield exactly one checksum per format.

The finished files also say which colours they mean: `tv` range, bt709.
Without that labelling, any downstream chain reads a `yuv420p` as full range
when in doubt and pulls the levels apart — the pixels would be right and the
picture wrong anyway. That is checked with `ffprobe` on a real encode, not on
the ffmpeg command line: an argument is an intention, the file is the result.

Portrait does not pay for this in sharpness, quite the opposite: a 9:16 crop
is exactly as large as the output frame, so it is not scaled at all but copied
1:1 out of the original.

### The filter that downscales

Capture is at 2560×1600 and delivery at 1920×1080, because that is the only
route to sharp text. The filter that performs this reduction is therefore not
an implementation detail but precisely the feature the high capture resolution
exists for. Downscaling uses a Lanczos-3 kernel — windowed sinc, separable,
stretched to the scale factor — the same method M1 used through ffmpeg.
Measured on four real capture frames, crop 2560×1440 → 1920×1080, so exactly
the 1.33× reserve:

| Filter                      | Edge energy (Laplacian RMS) | Round-trip PSNR |
| --------------------------- | --------------------------- | --------------- |
| **featurecast (Lanczos-3)** | **39.3**                    | **31.60 dB**    |
| ffmpeg Lanczos (M1)         | 39.3                        | 31.60 dB        |
| ffmpeg bicubic              | 35.7                        | 31.24 dB        |
| bilinear (round 2)          | 35.4                        | 30.72 dB        |
| ffmpeg area                 | 32.4                        | 30.61 dB        |
| ffmpeg bilinear             | 26.9                        | 30.02 dB        |

This costs computation, and a lot of it: a 16:9 frame out of the full raster
takes 179 ms instead of 17.6 ms, a 1:1 frame 109 ms instead of 10.7 ms — around
ten times as long. The crop that is exactly as large as the output frame is
still not filtered at all but copied row by row (0.18 ms), and it stays that
way: portrait lives on that 1:1 copy.

### What rendering costs, and on which machine

Cropping and scaling are the renderer's entire computational work and
therefore run on several threads: split by image rows across all formats,
weighted by the measured work per row — a format with no zoom reserve is
copied rather than filtered and counts accordingly little, otherwise the
threads that drew it wait for the rest. On top of that, no frame is computed
twice: a capture delivers fewer frames than the video has (m1-008: 1332
against 2873), and as long as source frame and crop stay the same, the
finished frame is the same one — the pointer goes on top of it afterwards.

Measured on the workstation (16 threads, under load), 300 real capture frames
from `artifacts/m1-008`, 11.8 seconds of video, 709 output frames, three
formats:

|                           | 1 thread | 6 threads | 14 threads |
| ------------------------- | -------- | --------- | ---------- |
| bilinear (round 2)        | —        | 18.2 s    | 16.2 s     |
| Lanczos-3, naive          | 190.2 s  | 82.2 s    | 67.3 s     |
| **Lanczos-3, with reuse** | —        | 43.4 s    | **38.3 s** |

The full recording, measured rather than extrapolated: `artifacts/m1-008`,
47.9 seconds of video, 2873 output frames, three formats, 14 threads —
**136.7 seconds**, so 2.9 seconds of computation per second of video, against
79 seconds with the bilinear variant. The milestone's two-minute limit
therefore holds for material up to around 42 seconds and is exceeded by this
recording by 14 %. **That is the deliberately paid price for the sharpness** —
not an oversight: the high capture resolution exists for exactly this filter,
and a softer picture would be a loss to the product, while a longer wait costs
convenience. Anyone weighing that differently has a measurably named
alternative in ffmpeg bicubic (31.24 dB against 31.60), which takes about half
as long.

The hardware assumption is therefore stated here rather than left implicit in
the code: **the calculation assumes a machine with at least eight cores.** The
default is "all cores minus two" — two are left for this thread, which drains
the decoder and feeds three encoders. On a three-core machine the renderer
composes on a single thread and is around five times slower than measured
here; the two-minute limit holds there for no recording worth the name.

Image rows are independent of each other, so the result does not depend on the
core count: the same run with one thread and with six produces the same file,
byte for byte. `--threads <n>` sets it but only changes the duration.

### One clock for frames and events

For a long time the event log carried **no clock time**, only a counter: it
advanced for everything the script does itself (pointer movement, typing,
`hold`) and stood still for everything that costs real time without being
planned — loading pages, waiting for stable geometry, the round trip of a
click. The error was not a uniform deviation that a factor could have
straightened out, but a staircase: in recording `m1-008` the offset added up
to **42.6 seconds** after 62 seconds, and that recording's only zoom framed an
empty search field 1.64 seconds before anything happened in it.

The recorder now reads the wall clock as it writes each event — the same clock
the capture stamps its frames with. The times live in **their own file beside
the log** (`event-times.jsonl`), not in it: two runs of the same script with
the same seed still deliver a bit-identical `events.jsonl`, and that is the
promise from M2. The clock time is different in every run, so it does not
belong in a file that is meant to stay the same.

The two are merged at render time, via the capture's start time. Because frame
and event times are epoch milliseconds from the same machine, that is a
subtraction and not an estimate. The old conversion has disappeared without
replacement, along with its two adjustment knobs.

**A recording without a time file can no longer be rendered.** It comes from a
version that did not know what time it was, and the renderer says so instead
of inventing a time — it has to be recorded again.

## One command for the whole chain

```sh
pnpm featurecast run demo/feature-xy.ts --devices desktop-wide --upload
```

`featurecast run` plays a recording script once per device, captures the
frames, sends them **through post-processing** — zoom, pointer, idle
compression — and uploads the result to S3-compatible storage on request. For
that, a script exports the body of the recording instead of calling `record()`
itself; the structure, the switches and the full example are in
[RECORDING-SCRIPTS.md](RECORDING-SCRIPTS.md#one-command-for-the-whole-chain).

Which device is captured is decided by its name alone: the resolved device
brings its capture area, its output size and its encoder setting all the way
into the ffmpeg invocation. All eleven presets run through, desktop as well as
mobile.

**What is delivered is the one size the device promises.** `--all-formats`
turns that into 16:9, 9:16 and 1:1 — out of the same recording, without a
second browser run. Three formats are a switch and not a default: two of them
would be crops nobody ordered, and out of a mobile recording two of the three
cannot be cut sharply at all.

Two folders sit side by side per device: the recording (`frames/`,
`timestamps.json`, the event log, and `device.json`, which names the device
and the pointer the render draws for it) and beside it the videos with their
`decisions.json`. Which is raw material and which is result is visible from
the folder.

**No look is changed here.** Every look switch belongs to `pnpm render`, which
reads a finished recording and costs no browser — that is exactly why
post-processing is a stage of its own.

## Development

```sh
pnpm install
pnpm browsers:install
pnpm demo:hello
```

## Repeating the M1 capture

The following manual command records a public, dense test interface for a good
20 seconds in the fixed 2560×1600 capture viewport. It stores JPEG frames,
`timestamps.json`, `capture-stats.json` and `browser.json` under the given
artifact folder and renders `output.mp4` from them. The render crops to 16:9
(`2560×1440`, 160 pixels off the bottom — nothing is taken off the top, that
is where the app's header sits) and then scales down to 1920×1080; it never
upscales.

```sh
pnpm demo:m1-capture
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration \
  -of json artifacts/m1-capture/output.mp4
```

The command is not an automated test. By default it starts the bundled
measuring corpus from `fixtures/bench/` over a local server and films that — no
account, no network, no third-party service, and the same interface for
everyone who clones the repository. A different public URL and an artifact
folder can be given as the first and second arguments. The artifact folder
must be new on every run, or deliberately deleted beforehand; the capture does
not overwrite existing artifacts. Use a unique path as the second argument for
that, for example
`pnpm demo:m1-capture https://example.com/ artifacts/m1-capture-001`.

**Which browser captures.** With no further instruction, Playwright's bundled
Chromium starts — a stock Chrome for Testing 154, pinned through the exact
Playwright version in `package.json`, the first release whose screencast takes
the frames-in-flight bound (ticket 137). A different binary is chosen through
`CHROME_BIN`:

```sh
CHROME_BIN=/path/to/chrome pnpm demo:m1-capture
```

A `CHROME_BIN` that is empty or does not name an executable binary aborts
before the start. After the start, the binary that is actually running is
queried from the operating system (`/proc`, hence Linux only); if it differs
from the one requested, the run aborts. Every run writes `browser.json` with
the absolute path, `--version` and the SHA-256 of the running binary into the
artifact folder, as does `record()` into its `out` folder. The hash is the
only field that tells apart two builds mounted at the same location that
report the same version line — exactly the case in the measurement rig, where
each arm mounts its build at `/crbuild` (ticket 36). Background: three days of
measurements were attributed to the wrong browser because a `CHROME_BIN` that
had been set was silently ignored (ticket 23).

Frame capture and disk writing are decoupled: `onFrame` only enqueues
synchronously, a separate writer writes in the background, so that a slow
write does not throttle the source frame rate (Playwright only acknowledges
the next screencast frame once `onFrame` returns, and swallows every error
while doing so). Before assembly, consecutive JPEG source frames are checked
for duplicates by SHA-256, and `capture-stats.json` records the median and p95
frame spacing along with the share of spacings ≤ 20 ms. `ffprobe` then checks
resolution, constant 60 fps, duration against the capture time span, and frame
count against a real 60 fps encode of that duration. For the M1 acceptance the
result is nonetheless watched and compared with a Screen Studio recording;
recording and comparison material are checked for private data before being
shared.

Prior work: `research/web-feature-recording-sota-2026-09.md` in the research
repository — 24 candidates, 18 checked in source, 9 measured through.
