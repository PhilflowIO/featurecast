# Capture cadence: resolution, quality, GPU backend, and content

Measured 2026-09-11, revised three times the same day. **Current finding
(see "Bisection on the AI box" at the end, which supersedes the quality-100
recommendation and the DOM-churn explanation below): capture is 2560×1600
at JPEG quality 90, because quality 100 measurably dropped ~9% of a real
dense UI's frames on the RTX 3090 box; and the M1 benchmark's low scroll
paint rate was its own timing — scrolling a grid that was still growing
into its final height — not a capture limit.** The sections below are kept
as the measurement history that led there.

## What was wrong the first time

The original version of this document measured `requestAnimationFrame`
rate with `page.screencast` **detached** and concluded "the browser is
never the bottleneck, capture always is" — true only in that specific,
misleading setup. With the screencast **attached** (the condition that
actually matters), the page's own paint rate drops too, because headless
Chromium was rasterizing entirely in software (SwiftShader) the whole
time: `UNMASKED_RENDERER_WEBGL` reported `"ANGLE (Google, Vulkan 1.3.0
(SwiftShader Device...), SwiftShader driver)"` despite this workstation
having a real, usable GPU (`glxinfo -B`: `AMD Radeon 860M Graphics
(radeonsi)`, `direct rendering: Yes`). Software rasterization at
2560×1600 is the actual bottleneck; it was never "layout cost of the big
viewport" as the first version claimed.

## The fix

`src/renderer.ts` launches the capture browser with
`--use-gl=angle --use-angle=gl-egl` (`HARDWARE_GL_LAUNCH_ARGS`), which
switches ANGLE onto the real GPU
(`ANGLE (AMD, AMD Radeon 860M Graphics (radeonsi krackan1 ACO), OpenGL ES
3.2)`), and detects+records the active renderer in `capture-stats.json` so
a silent fallback to software rendering — which still produces a
technically-valid, constant-fps, correctly-durationed video that every
ffprobe/duration check accepts, just at a much lower real frame rate — is
never invisible again. `assertHardwareRenderer` fails the capture loudly
if the renderer string matches SwiftShader/software/llvmpipe/softpipe,
unless `FEATURECAST_ALLOW_SOFTWARE_RENDERER=1` is set.

## Method (corrected)

`page.screencast.start({ onFrame, quality, size })` measured for **10s**
per configuration (up from 2.5s — the previous window was short enough
that quality's effect measured as noise when it isn't), with rAF sampled
**while the screencast is attached** (not detached, per the mistake
above), across:

- **dense**: the same 70×18 animated table fixture as before.
- **light**: the same single sliding `<div>` fixture.
- both the default (software) and hardware-GL launch args.

Raw numbers were written to a throwaway scratch directory outside this
repository and are not preserved; the results table below is what survives
of them. Comparison stills are committed at `docs/stills/` (see below).

## Results

| GL backend         | page      | capture size  | quality | capture fps | rAF fps (attached) | median frame size |
| ------------------ | --------- | ------------- | ------- | ----------- | ------------------ | ----------------- |
| software (default) | dense     | 2560×1600     | 100     | 28.5        | 31.4               | 2977 KB           |
| software (default) | dense     | 2560×1600     | 80      | 32.5        | 32.2               | 1054 KB           |
| software (default) | dense     | 1920×1200     | 100     | 46.1        | 48.9               | 1670 KB           |
| software (default) | dense     | 1920×1200     | 80      | 54.2        | 51.8               | 591 KB            |
| software (default) | light     | 2560×1600     | 100     | 62.3        | 59.5               | 25 KB             |
| **hardware GL**    | **dense** | **2560×1600** | **100** | **59.2**    | **60.0**           | 2982 KB           |
| hardware GL        | dense     | 2560×1600     | 80      | 57.3        | 60.1               | 1059 KB           |
| hardware GL        | dense     | 1920×1200     | 100     | 56.4        | 60.0               | 1675 KB           |
| hardware GL        | dense     | 1920×1200     | 80      | 60.2        | 60.0               | 594 KB            |
| hardware GL        | light     | 2560×1600     | 100     | 60.3        | 60.1               | 25 KB             |

(Full table incl. all quality/size combinations: `table.md`.)

**Correction (second review, same day): the "59.2fps at 2982KB mean frame"
row above is not reproducible and violates a real throughput ceiling.**
59.2fps × 2982KB implies ~176MB/s sustained out of the screencast pipe;
independently re-measured (own rerun, `matrix.mts`, hardware GL, 8s
samples, a heavier uniformly-dense 70×18 table so JPEG compression can't
get lucky on empty space) the actual numbers are:

| capture size | quality | capture fps | rAF fps | mean frame size | implied throughput |
| ------------ | ------- | ----------- | ------- | --------------- | ------------------ |
| 2560×1600    | 100     | 25.1        | 60.0    | 3432 KB         | ~86 MB/s           |
| 2560×1600    | 20      | 59.6        | 60.0    | 443 KB          | ~26 MB/s           |
| 1920×1200    | 100     | 39.0        | 60.0    | 2518 KB         | ~98 MB/s           |
| 1280×800     | 100     | 59.9        | 59.9    | 1109 KB         | ~66 MB/s           |

(`implied throughput = mean frame size × capture fps`; "MB/s" here because
the earlier probe script mislabeled this quantity "KB/s" while computing
it correctly — `bytes / wall_ms / 1024` is numerically `KB × fps / 1000`,
i.e. MB/s. Corrected here, not just in the number.)

**There is a hard ceiling around 80-100MB/s on this box, independent of
resolution or quality individually.** 2560×1600/q100's 3432KB mean frame
caps capture at ~25fps regardless of the GPU backend being fully warmed
(rAF is 60fps throughout — the page is never the bottleneck once hardware
GL is in use; the JPEG-encode-and-transfer pipe is). 1280×800/q100 reaches
full 60fps because its 1109KB mean frame fits under the ceiling with
headroom; 2560×1600/q20 reaches 59.6fps for the same reason at a much
larger resolution, by cutting frame size instead of resolution.

**Practical rule: keep the mean JPEG frame size under ~1.3MB
(80MB/s ÷ 60fps) to sustain 60fps, regardless of how that frame size is
reached** — lower resolution, lower quality, or (as with the recorded
application) content that simply compresses smaller than a synthetic worst
case. That application's real frames average 408KB in the `artifacts/m1-003` acceptance run — well
under the 1.3MB budget — which is _why_ 2560×1600/q100 reaches ~54fps on
its real content despite this synthetic dense-table probe topping out
at 25fps at the same size/quality. The earlier "2560×1600/q100 sustains
60fps" claim was true for that application specifically and false as a general
statement about that resolution/quality pair; a denser or more colorful
target app could still hit this ceiling at the current default.

Real M1 acceptance run (`artifacts/m1-002`, before the GPU-backend fix)
landed at 314 source frames over 29.75s, median 59.1ms (~17fps) — far
below even this ceiling, because `m1-002` additionally suffered from the
dead-scroll-pass bug (see the main report): frames that never arrived at
all during two ~4.7s stretches with zero repaints, not a throughput
problem. `artifacts/m1-003`/`m1-004` (GPU-backend fix plus the benchmark
fix) are the numbers to compare against this table.

## Is it encoding, layout, or throughput?

Layout is ruled out: rAF stayed at 60fps in every configuration once
hardware GL was in use, including 2560×1600 dense at q100 (the slowest
capture-fps case, 25.1fps) — the page itself was never waiting on
anything. What remains is JPEG encode + transfer cost, which scales with
frame _byte size_, not resolution or quality independently — 2560×1600/q20
and 1280×800/q100 both reach ~60fps at similar mean frame sizes
(443KB/1109KB) despite a 4x difference in pixel count, while 2560×1600/q100
and 1920×1200/q100 both bottleneck around the same ~80-100MB/s regardless
of their different resolutions. Frame size is the one variable that
predicts fps across every row in the table above.

## Sharpness

Unchanged conclusion, re-verified with the hardware-GL stills committed
at `docs/stills/cadence-2560x1600-q100.png` and
`docs/stills/cadence-1920x1200-q100.png`: both render sharp, readable
text with no visible scaling blur; 2560×1600 fits more table columns at
the same on-screen text size (PLAN.md's 1.33× zoom-reserve reasoning).

## Recommendation

**Superseded 2026-09-11 by the AI-box bisection at the end of this
document: capture now runs at quality 90.** The original recommendation
read: keep 2560×1600/q100 as the default, but on the record that this is a
content-dependent decision, not a resolution-independent one. Two
independent constraints govern cadence: the GPU backend (fixed by
`renderer.ts` — `assertHardwareRenderer` makes a regression back to
software rendering a loud failure instead of a silent 17-31fps capture
that still passes every duration/frame-count check) and a hard ~80MB/s
screencast throughput ceiling that no backend or resolution choice
removes. 2560×1600/q100 stays because the recorded application's real frames (408KB mean)
fit comfortably under the ~1.3MB budget that ceiling implies at 60fps —
not because 2560×1600/q100 is fast in general (the synthetic dense-table
probe above tops out at 25fps at that exact size/quality).

If a future target app's frames are heavier (more colorful, less
whitespace, higher-entropy content that compresses worse — the exact
opposite of what makes the recorded application's frames small), the same 2560×1600/q100
default will re-hit this ceiling regardless of the GPU backend. The fix in
that case is smaller frames, most cheaply via quality (`q20` reaches 60fps
even at full 2560×1600 in the table above) rather than resolution, since
quality has no effect on sharpness once downscaled and cropped the way
`assemble.ts` already does. `capture-stats.json`'s per-run median frame
size (derivable from `medianIntervalMs` and the known ~80MB/s ceiling, or
tracked directly in a future revision) is the way to notice this before a
capture silently degrades to a slideshow-adjacent cadence again.

## Capture efficiency: a separate question from cadence (added 2026-09-11)

Everything above answers "how fast did the source deliver frames" —
`shareUnderTwentyMs` and friends. That number mixes two unrelated causes: the
captured app's own paint rate, and any loss between "the browser painted a
frame" and "this pipeline received it". `src/efficiency.ts` isolates the
second one directly: an in-page `requestAnimationFrame` counter
(`src/paint-rate.ts`) timestamped on the same clock as the capture manifest,
compared window by window. M1's acceptance pipeline (`demo/m1-capture.ts`)
now gates on this (95% floor) instead of on the repeated-output-frame share,
which stays as a reported (not gating) slideshow-detection number.

**Correction (superseded by the AI-box measurement below): "the app itself
paints only ~21fps while scrolling" was wrong.** That number was measured
on this workstation's iGPU, against `.MuiDataGrid-virtualScroller` as the
scroll target — a selector since proven wrong on its own terms (see
`src/m1-benchmark.ts`'s `findLargestScrollElement`: that element's live
range varies from 2px to 500+px depending on MUI's row-virtualization
layout timing, so the "scroll" it measured was frequently near-empty). On
the AI box's RTX 3090, with the corrected scroll target and counting
**distinct content changes** rather than raw paint ticks, the same real
dense table view delivers ~58-60 content changes/s while scrolling — the
app was never the bottleneck; both the wrong scroll target and this
workstation's weaker iGPU were. The paragraph immediately below (the
~14fps/~69%-loss number) is **workstation-only** and reflects that iGPU,
not a property of the recorded application. See "AI-box acceptance run" further down for
the corrected, decisive numbers.

**Where the loss actually is (workstation, iGPU).** Measured directly
against the recorded application's real `tasks`-grid scrolling on this box: the page painted
~21fps (in-page rAF, screencast attached, using the since-corrected scroll
target) while this pipeline only captured ~14fps of it — a real ~69%
efficiency loss on this hardware, not a page-paint-rate problem general to
the recorded application. Isolating the cause with
synthetic fixtures (no Playwright interaction, a trivial `() => count++`
`onFrame` with no I/O, so this pipeline's own write queue is provably not
engaged):

| fixture                                                                     | mechanism                                           | efficiency                   |
| --------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| light (single sliding div)                                                  | compositor-only transform                           | 100%                         |
| dense (400 colorful cells)                                                  | compositor-only transform                           | 98.9%                        |
| layout-thrash (400 cells, forced synchronous layout every frame)            | main-thread layout, no DOM churn                    | 97.8%                        |
| DOM churn (create/destroy real nodes every frame, MUI-virtualization-style) | main-thread layout **and** node create/destroy      | 45-86% (run-to-run variance) |
| same DOM-churn fixture, quality lowered 100→20                              | less Chromium-side JPEG-encode CPU cost, same churn | 96.7%                        |

The CDP `Page.screencastFrameAck` round-trip (arrival→ack, instrumented
directly in playwright-core's `CRPage._onScreencastFrame`) stayed 1-2ms
median in every row above, including the lossy ones — this pipeline's own
ack handling and write queue are not the cause. Real DOM node
creation/destruction (not style/layout mutation alone) reproduces the loss
in isolation, and reducing JPEG-encode cost (lower quality) recovers it,
which together point at Chromium's own screencast frame production
competing with the captured page's own DOM-mutation cost for CPU — genuinely
upstream of this codebase, not a bug in `capture.ts`.

**Consequence for the quality/size trade-off already described above:**
lowering quality is not just a throughput lever for the ~80-100MB/s ceiling,
it is also the one lever that recovered capture efficiency during real DOM
churn in the measurement above. A future target app whose interactions
trigger heavy virtualization-style DOM churn may need a lower quality (or
smaller capture size) specifically to keep capture efficiency — not just
frame-byte throughput — above the 95% floor.

**Corroborated cross-hardware, at a fixed 60fps paint rate.** The workstation
measurements above hold a real app's paint rate constant only indirectly
(through DOM-churn fixtures); a second measurement on the AI box's RTX 3090
(`--use-gl=angle --use-angle=gl-egl`, a synthetic dense 70×18 table with a
continuous CSS transform — compositor-only, no DOM churn, so the page paints
a genuine, stable 60fps throughout) isolates the _encode-cost_ variable on
its own: paint stayed 59.7-59.8fps in every row, but capture ranged
48.0fps/~80% efficiency (quality 90, 899KB mean frame, 42.1MB/s) down to
45.6fps/~76% (angle vulkan, 892KB, 39.7MB/s) — well under the ~80-100MB/s
ceiling, so this is not a transport-bandwidth effect either. Repeating the
same fixed-60fps-paint test on this workstation's weaker APU (bigger,
1260-cell fixture, `--use-gl=angle --use-angle=gl-egl`) reproduces the same
shape at every quality/size point tried, ack round-trip staying 1-2ms median
throughout (ruling out this codebase's ack handling on both boxes):

| quality | capture size | mean frame | efficiency (60fps paint held constant) |
| ------- | ------------ | ---------- | -------------------------------------- |
| 100     | 2560×1600    | 2217.5 KB  | 49.8%                                  |
| 90      | 2560×1600    | 1104.8 KB  | 68.0%                                  |
| 80      | 2560×1600    | 792.2 KB   | 86.1%                                  |
| 70      | 2560×1600    | 659.5 KB   | 97.5%                                  |
| 100     | 1920×1200    | 1430.3 KB  | 86.3%                                  |
| 100     | 1280×800     | 834.0 KB   | ~100%                                  |

Frame byte size predicts efficiency here at least as cleanly as it already
predicted cadence in this document's original table — which means the
~80-100MB/s "ceiling" described above was very likely this same
efficiency-loss mechanism observed indirectly through fps, not a literal
transport bandwidth limit: Chromium's screencast production does not queue
and eventually deliver a slow-to-encode frame later, it drops it outright
(confirmed by the fast, unaffected ack round-trip on every delivered frame),
so a heavier per-frame encode cost shows up as missing frames, not merely
slower ones. **The recorded application's real frames during scroll (615-660KB median,
comparable to this table's q70 row) would predict near-full efficiency from
byte size alone** — the measured 45-86% loss during real DOM churn
(`artifacts/m1-006`/`m1-007`) is therefore not explained by frame size on
its own; DOM-churn CPU cost and encode CPU cost both draw on the same
budget and compound. Both are upstream of `capture.ts`.

## Bisection on the AI box: why the benchmark captured 83-89% (added 2026-09-11)

**This section supersedes the "upstream DOM churn" explanation above for
the M1 benchmark.** The acceptance run `artifacts/m1-007` reported 82.6%
capture efficiency while an isolated probe on the same box captured
97.6-99.3%. Walked from that probe to the benchmark one difference at a
time, serially on GPU1 (RTX 3090, `--use-gl=angle --use-angle=gl-egl`,
renderer logged every run), the recorded application's real dense table
view, 12s per step.
Efficiency is captured frames ÷ distinct content changes counted per rAF
tick in the page (scroll positions of the grid scroller and `main`, plus
the grid's height).

| step | configuration                                                   | changes/s   | captured/s  | efficiency      |
| ---- | --------------------------------------------------------------- | ----------- | ----------- | --------------- |
| 1    | raw `page.screencast` q90, in-page rAF scroll of settled `main` | 58.2        | 57.2        | 0.983           |
| 1    | same, one `mouse.wheel` per 60Hz slot                           | 58.7        | 57.0        | 0.970           |
| 1'   | raw q**100** (the product's quality), rAF, three runs           | 58.8-59.7   | 51.3-54.6   | **0.873-0.915** |
| 1'   | raw q100, wheel, two runs (wheel rate falls to 52/s)            | 51.7-52.4   | 45.0-45.7   | **0.859-0.884** |
| 2    | q90 rAF + frame writes to container fs / bind mount             | 59.3 / 60.3 | 57.3 / 58.8 | 0.966 / 0.975   |
| 2    | q100 rAF + frame writes to bind mount                           | 60.1        | 54.3        | 0.904           |
| 3    | product `captureScreencast` (q100), rAF, container fs / bind    | 60.5 / 60.3 | 54.5 / 53.3 | 0.901 / 0.883   |
| 3b   | + product `startPaintRateProbe`                                 | 60.0        | 53.9        | 0.899           |
| 4    | product (q100) + `demo.scroll` legs on settled `main`           | 47.7        | 39.8        | 0.834           |
| 5    | product (q100) + `demo.scroll` on the **still-growing** grid    | **21.0**    | 20.2        | 0.960           |
| 6a   | the product's full motion script, clicks/typing/sorts no-op'd   | 31.9        | 28.6        | 0.896           |
| 6b   | the same script unmodified                                      | 31.0        | 28.6        | 0.922           |

Steps 6a/6b are totals over all scroll windows; the product's own
`capture-efficiency.json` number for 6b was 0.837. Quality sweep (raw
pipeline, rAF scroll, bind-mount writes, two runs each): q100 0.912/0.915
(698KB mean frame), q95 0.952/0.958 (439KB), q90 0.982/0.990 (351KB), q85
0.986/0.987, q80 0.982/0.987. Write I/O (step 2), the product queue (step 3) and the paint probe (step 3b) each stay within run-to-run noise of the
step before them.

**Mechanism 1 — capture loss: JPEG quality 100.** The first material drop
is 1 → 1', and every later step inherits it. Chromium drops a screencast
frame whose encode misses the frame budget; at quality 100 a real frame of
the recorded application is twice the bytes of quality 90 and ~9% of changes are never
delivered. Fix: `CAPTURE_QUALITY = 90` in `src/capture.ts`, the highest
quality that measured ≥98%.

**Mechanism 2 — too few changes: scrolling a layout that is still
growing.** After a table switch the recorded application's DataGrid root starts at the
height the previous view left and grows by 1px per rendered frame until it
fits every row (27s for `tasks` after the Projects view; measured with an
in-page layout log). While it grows, (a) scroll range drains from
`.MuiDataGrid-virtualScroller` into `main` — their sum stays ~590px — so
the benchmark's largest-range rule picked whichever held more at that
instant (the grid at the benchmark's 700ms dwell in 3/3 runs, `main` on a
direct visit), and (b) the page itself runs at 22-24fps with a 51-57ms
median wheel round trip, so a 521px `demo.scroll` takes 2.8s instead of
~0.8s (step 5, and every cycle-1 `tasks`/`invoices` scroll window in step
6: 21-28 changes/s). Scroll-window time also included 190-260ms of target
discovery before the first wheel while the page was that busy (30-50ms
when settled). Fix: `waitForStableScrollGeometry` in `src/m1-benchmark.ts`
blocks target choice until every scroll range has been unchanged for
500ms, and each scroll window now spans only the `demo.scroll` call and
names the element it scrolled. A pointer-anchored alternative (wheel at the
grid centre, let the browser chain inner → outer) was tried and rejected:
during growth it covered only 388-399px of 591px in 11.2-11.4s (3/3 runs).

**Reconciling m1-007's 82.6% efficiency with its 57.6% repeated share.**
Both are consistent once the change rate is measured instead of assumed:
over m1-007's 13 scroll windows the page produced 35.5 changes/s (not 60)
and 29.2 were captured, which predicts 1 − 29.2/60 = 51.3% repeated output
frames. The remaining 6 points come from bunched delivery in the short
cycle-2 windows (49-62% of frame gaps ≤20ms): two frames inside one 16.7ms
output slot yield one output frame.

**The product's paint counter agrees on scrolling, not on everything.** In
a capture configuration with encode headroom (1280×800, q50: rAF scroll
captured 99.9%), `paint-rate.ts` agreed with the independent counter
exactly for scrolling in isolation (60.0 vs 60.0 changes/s for rAF scroll,
54.0 vs 54.0 for `demo.scroll`). Over the full benchmark in that same
headroom configuration, however, only 92.4% of the ticks it counted
produced a captured frame, so for clicks, sorts and transitions its
denominator is not proven to equal frames Chromium could deliver (see the
open gap below).

## Acceptance after both fixes (`artifacts/m1-008`, three runs)

Three serial acceptance runs on the RTX 3090 box with quality 90 and the
settle wait (`artifacts/m1-008/runs/accept-r{1,2,3}.json`; run 1's full
capture is `artifacts/m1-008`, ffprobe h264 1920×1080, 60fps, 3767 frames,
62.78s):

| run | all scroll windows: distinct changes/s | captured/s | efficiency vs distinct | repeated share | product gate |
| --- | -------------------------------------- | ---------- | ---------------------- | -------------- | ------------ |
| 1   | 49.3                                   | 48.8       | 0.990                  | 0.329          | 85.7% FAIL   |
| 2   | 49.0                                   | 48.1       | 0.982                  | 0.249          | 84.2% FAIL   |
| 3   | 48.9                                   | 48.4       | 0.990                  | 0.319          | 84.1% FAIL   |

All 12 scroll windows chose the same element in all three runs (`main` for
vertical passes, `.MuiDataGrid-virtualScroller` for the 180px horizontal
passes). Counter-examples E and F remain rejected (`tests/repeats.test.ts`).
Scroll paint rate rose from 31-35 to ~49 changes/s, and scroll capture is
essentially complete.

**Open (not proven): the remaining gate gap.** (Mechanism for the first two
windows found by trace, see "Trace: presented vs captured frames" below.) It concentrates in the
same windows in every run: `tasks:scroll-right` (15 scroll ticks, 4-5
frames, no frame for the first ~240ms), `invoices:sort-asc` (16-17 counted
ticks, 1-3 frames) and `dark-mode-toggle` (0.73-0.85 at q90 vs 0.96 at
headroom, i.e. real encode loss on a full-page colour transition). The first
two under-deliver even with encode headroom while Chromium's renderer
`DrawFrame` trace events count 13-18 draws, and neither reproduced when the
interaction was run in isolation, so their mechanism is still unknown.

## Trace: presented vs captured frames (added 2026-09-11)

Question: does the gate's denominator (`paint-rate.ts`'s change-signal ticks)
over-count, i.e. were the missing frames never presented by Chromium, or did
Chromium present frames the screencast skipped? Answered with a browser-level
CDP trace across the unchanged product pipeline (`captureScreencast` at
2560×1600, bind-mount writes, the product's full motion script), serially on GPU1
(RTX 3090, ANGLE GL, Chromium 153.0.8010.12), nine runs. Per window it
counts the product's ticks, frames viz actually drew
(`Display::DrawAndSwap`), frames the viz video capturer took
(`gpu.capture` `Capture`), frames the capturer refused (`FpsRateLimited`),
and frames delivered to the manifest. The scripts live in the measurement
workspace on the AI box — a scratch directory next to this checkout, not part
of this repository: `presented.ts` (with a per-tick animation logger in
`presented-t1`), `presented-quality-chain.sh`, `presented-gap.ts`,
`presented-analyze.py`, `presented-aggregate.py`. Each run leaves a summary
JSON and a gzipped trace, `<run>.json` and `<run>.trace.json.gz`.

| run          | quality | idle after scroll-up | gate (delivered/tick) | delivered/presented | viz captured/presented | `tasks:scroll-right` tick/presented/captured/refused/delivered | `invoices:sort-asc` tick/presented/captured/refused/delivered | `dark-mode-toggle` tick/presented/captured/delivered |
| ------------ | ------- | -------------------- | --------------------- | ------------------- | ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| presented-t1 | 90      | 0                    | 0.838                 | 0.810               | 0.912                  | 30/27/10/32/8                                                  | 32/33/4/49/4                                                  | 25/25/25/21                                          |
| pq-q90-r1    | 90      | 0                    | 0.932                 | 0.910               | 0.980                  | 37/36/15/39/10                                                 | 54/54/54/0/55                                                 | 26/26/26/21                                          |
| pq-q90-r2    | 90      | 0                    | 0.838                 | 0.821               | 0.914                  | 34/28/12/32/10                                                 | 32/32/4/50/4                                                  | 24/24/24/19                                          |
| pq-q85-r1    | 85      | 0                    | 0.850                 | 0.823               | 0.923                  | 32/27/11/32/8                                                  | 31/31/3/50/3                                                  | 26/25/25/21                                          |
| pq-q85-r2    | 85      | 0                    | 0.864                 | 0.824               | 0.913                  | 30/27/11/30/9                                                  | 33/32/4/49/4                                                  | 25/25/25/21                                          |
| pq-q80-r1    | 80      | 0                    | 0.842                 | 0.824               | 0.926                  | 30/27/10/32/8                                                  | 33/32/4/50/4                                                  | 26/25/25/20                                          |
| pq-q80-r2    | 80      | 0                    | 0.853                 | 0.823               | 0.917                  | 30/28/10/32/7                                                  | 33/32/4/49/4                                                  | 26/25/25/21                                          |
| pg-gap400-r1 | 90      | 400ms                | 0.851                 | 0.837               | 0.973                  | 32/28/29/0/25                                                  | 25/28/28/10/17                                                | 26/25/25/20                                          |
| pg-gap400-r2 | 90      | 400ms                | 0.875                 | 0.860               | 0.970                  | 30/28/28/0/22                                                  | 26/28/29/4/24                                                 | 25/25/25/21                                          |

Window columns sum both cycles. `refused` counts `FpsRateLimited` events for
both compositor and refresh triggers, so it can exceed `presented`.

**The denominator is not the gap.** Ticks and presented frames agree within
2-4% over all windows (624 vs 646, 837 vs 857, 628 vs 641) and inside the
failing windows (e.g. 30 vs 27, 32 vs 33). Chromium _did_ present the frames
the screencast is missing; switching the gate to presented frames would make
it stricter (0.81-0.91), not pass. `pq-q90-r1` is not comparable to the other
runs: the recorded application's live layout gave it 42 motion windows instead of 38, and its
invoices sort was not preceded by a long scroll (see mechanism 3).

**Mechanism 3 — capture loss: Chromium's animated-content lock-in.** The
screencast is fed by viz's `FrameSinkVideoCapturerImpl`, which asks
`VideoCaptureOracle` before each capture and emits `FpsRateLimited` when it
says no (`components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc:826-838`).
Once one damage rect has animated for ≥1s at ≥12fps, the oracle's
`AnimatedContentSampler` locks onto it
(`media/capture/content/animated_content_sampler.cc:27-38`, `:241-252`) and
refuses every frame whose damage rect differs (`:100-103`; its decision
replaces the smooth sampler, `video_capture_oracle.cc:163-176`), until 250ms
after the locked rect's last damage (`:33`, `:226-227`). The lock-in is on by
default (`animated_content_sampler.cc:51`), its only switch is the mojo call
`SetAnimationFpsLockIn`, and neither `devtools_video_consumer.{h,cc}` nor
`protocol/page_handler.cc` (the screencast path) calls it; no launch flag or
CDP `Page.startScreencast` parameter that disables it was found. In the benchmark, ~0.9s vertical passes of `main`
lock the sampler; the horizontal grid scroll right after damages a
different rect and is refused for its first ~240ms (trace timeline in
`presented-t1`: `FpsRateLimited` on every presented frame from 70ms to 223ms
of the window, first capture at 236ms). The invoices sort is preceded by a
0.7s scroll-up whose lock refuses the tooltip fade the click triggers.
**Counterfactual:** the same benchmark with 400ms idle after every
scroll-up (`presented-gap.ts`, runs `pg-gap400-*`) drops refusals in
`scroll-right` from 30-39 to 0 and in `invoices:sort-asc` from 49-50 to
4-10; the refusals move into the preceding scroll-up windows (28-31), where
the idle time now sits. The mechanism is proven causal, and it is a real
video defect (a horizontal scroll whose first quarter-second is a freeze),
not a counting artifact.

**Mechanism 4 — DevTools' in-flight limit, not duplicate folding (resolved by
an independent re-measurement).** Even with the lock released, viz captures
97% of presented frames but only 84-86% reach the manifest. An adversarial
verifier separated the two candidates on the box — its own parser and a raw
pre-fold counter in a throwaway copy of the capture code, run outside this
repository: for `dark-mode-toggle`, 26 frames were
captured by viz, 22 reached the `onFrame` callback, 1 was folded as a
byte-identical redelivery, 21 landed on disk. Four of the five missing frames
therefore die in DevTools, not in `src/capture.ts`. No delivered frame had
more than two unacknowledged predecessors while every dropped one had two to
three, which is the documented behaviour of
`content/browser/devtools/protocol/page_handler.cc:1808-1821`
(`kMaxScreencastFramesInFlight = 2`). Attribution per frame is possible
because DevTools stamps the frame only after the drop check
(`page_handler.cc:177`, called at `:1850`), a median 0.38ms after capture end.
Unlike the lock-in, this loss is attackable from our side: acknowledge
earlier, make frames smaller, or leave the DevTools path.

**The lock-in has no reachable off-switch (independently re-verified).** At
the pinned Chromium 153.0.8010.12 from the Playwright 1.63 image, the mojo
call `SetAnimationFpsLockIn` exists
(`frame_sink_video_capturer_impl.cc:372-381`, `video_capture_oracle.h:81-86`,
`animated_content_sampler.h:30`, default on per
`frame_sink_video_capture.mojom:175` and `animated_content_sampler.cc:51`),
but across 108 files loaded at that revision it appears only in the client
pass-through (`client_frame_sink_video_capturer.cc:42-49, 219-220`), the
implementation and three test doubles — no production caller, no
`base::Feature`, no command-line switch, no CDP parameter
(`Page.pdl:1161-1174` exposes only format, quality, width, height, every-nth-
frame). `Page.startScreenRecording` does not help either: it runs through
`WebContentsVideoCaptureDevice` -> `FrameSinkVideoCaptureDevice`, which sets
only period and resolution (`frame_sink_video_capture_device.cc:327-332`).
The verifier also strengthened the causal proof: at every single refusal of a
presented frame (56/56 without idle, 24/24 with idle, 59/59 in `presented-t1`)
the smooth sampler's token bucket stood at >=10ms 7-10us earlier, so both the
minimum capture period and the smooth sampler would have said yes
(`video_capture_oracle.cc:162-176`); utilization throttling is excluded
because it only scales size (pinned by `SetResolutionConstraints min=max`) and
no `PipelineLimited` event occurred.

**Quality does not help either loss.** Quality 85 and 80 delivered 21/21 and
20/21 dark-mode frames against 21/19/21 at 90, with the same `scroll-right`
and `invoices:sort-asc` refusals; gate 0.850/0.864 (q85), 0.842/0.853 (q80)
vs 0.838/0.838 (q90, excluding `pq-q90-r1`). `CAPTURE_QUALITY` stays 90.

**Not verified here:** these traced runs carry tracing overhead and are not
acceptance runs (the last untraced acceptance is `artifacts/m1-008`); a
capture path that bypasses the viz oracle (e.g.
`HeadlessExperimental.beginFrame` screenshots) is untested; the
re-measurements above are single runs per variant, so run-to-run spread is
unknown; the completeness of the caller search rests on GitHub's code-search
index over the Chromium mirror.

## PLAN.md / docs/DEVICES.md divergence (resolved 2026-09-14, ticket 55)

Fixing the crop-shears-the-toolbar defect (see the main report, item 5)
surfaced a disagreement between the two docs that this task did not resolve:
PLAN.md specified capturing 2560×1600 (16:10) and cropping to 16:9 for a
deliberate 1.33× zoom reserve, while `docs/DEVICES.md` listed 2560×1440
(16:9 natively, no crop) as the `desktop` preset.

Over-capturing won, and `docs/DEVICES.md` was the entry that changed: all
three desktop presets now record 2560×1600. The reason is not the zoom
reserve alone but M4 — several output formats cut from one recording without
a second browser run, plus a zoom that frames the element each click hit.
Both spend pixels outside the finished frame, and a natively-16:9 capture has
none. The honest limit of that margin is written down in `docs/DEVICES.md`:
16:9, 16:10 and 1:1 fall out of it sharp, 9:16 does not.

## The capture clock and the efficiency denominator (added 2026-09-12, ticket 21)

Two numbers this document relied on were being produced the wrong way. Both
are fixed; the corrected figures supersede every efficiency percentage above.

### What `metadata.timestamp` on a screencast frame actually is

Not the moment the compositor produced the frame, and not the moment it was
presented. It is `base::Time::Now()` — plain wall clock — read in the browser
process when the DevTools handler builds the frame's metadata:
`content/browser/devtools/protocol/page_handler.cc:178`,
`.SetTimestamp(base::Time::Now().InSecondsFSinceUnixEpoch())`, called from
`OnFrameFromVideoConsumer` (same file, 1814-1861). Pinned tree,
Chromium 153.0.8010.12, built from source on the measurement box.

A better timebase exists and is one field away. The capturer writes the
oracle-smoothed presentation time onto the VideoFrame
(`components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc:1511`)
and ships it over mojo as `info->timestamp` (same file, 1527), where
`DevToolsVideoConsumer::OnFrameCaptured` puts it back on the frame
(`content/browser/devtools/devtools_video_consumer.cc:182-185`) — and
`PageHandler` never reads it. It is not reachable over CDP without a patch.
Measured cost of using the arrival stamp instead: the lag from presentation
to arrival is 2.4-8.4 ms at the median and 6.6-12.3 ms at p95 across the
product runs below, so the arrival stamp is a tight proxy. Re-basing the
timeline onto the presentation times was built and measured on two full
runs; it makes the finished video **worse**, and the numbers are in
"Re-basing the timeline" below.

### Delivery order is not capture order, and the timestamps were the casualty

`ScreencastFrameCaptured` hands the bitmap to `base::ThreadPool` for JPEG
encoding and the CDP event is emitted from the encode's reply
(`page_handler.cc:1864-1893`), so frames arrive in encode-completion order
while their timestamps were assigned strictly in capture order on one
sequence. `capture.ts` used to treat delivery order as authoritative and
clamp a regressing timestamp forward onto its predecessor. Measured on
`artifacts/sbs-patched`: 42 clamps, and 39 inter-frame gaps of **exactly
0.0 ms** — every zero gap in that run was manufactured by the clamp, none
was a resolution tie (1415 of its 1416 timestamps carry a fractional
millisecond). A zero-gap frame gets no `duration` line in the ffconcat
timeline, so ffmpeg steps past it and its neighbour holds twice as long.

The manifest is now sorted back into capture order instead. On a real run
with the fix (`wt-clock/artifacts/clock-r1`, patched Chromium, AI box):
48 frames restored to order, `coincidentTimestampCount` 0, zero-length gaps 0.

### The efficiency denominator was the in-page probe, and then it was double-counted

`src/paint-rate.ts` runs on the renderer's main thread; smooth scrolling is
driven by the compositor thread. During exactly the motion this project
records, the probe therefore sees fewer frames than reach the screen — 51
against 66 in one measured window. `captured / ticks` consequently rises as
the machine degrades, and the patched-Chromium arm reported **100.9%**
capture efficiency, which the 95% gate passed.

The denominator is now Chromium's own presented frames, taken from a
two-category browser trace and computed in-process at the end of the run
(`src/presented.ts`). Predicate: `PipelineReporter` async events in the
renderer process whose `b` phase carries state `STATE_PRESENTED_ALL` or
`STATE_PRESENTED_PARTIAL`, bucketed at the paired `e` timestamp.

The first version of that counted Chromium's _reports_ of a presentation
instead of the presentations. Chromium files one record per reporting
pipeline in the renderer, all carrying the same `e` timestamp: measured on a
product run, **2238 records against 1510 distinct presentation instants**,
728 instants reported exactly twice and none more than twice. Of the 752
`STATE_PRESENTED_PARTIAL` records, 669 are the twin of an `ALL` record of the
same instant; the remaining 83 are separate screen updates and are measured
to be so — 20.8 ms from the nearest `ALL`-bearing instant at the median,
4.1 ms at the minimum, none sub-millisecond, and 16.6 ms after their own
predecessor at the median, which is one 60 Hz refresh.

**The check that settles it without reading any Chromium source:** a window
cannot contain more presentations than the display refreshes inside it. That
is `floor(duration × refreshHz) + 1` — both edges of the window can carry
one — and the fencepost matters. The window `invoices:scroll-down:1` reported
89.8 presented frames per second under the record-counting denominator;
counting instants it reports 59.6.

Two things about this bound were wrong until round three, and both stopped it
binding in practice.

It was written as `duration × 60`, with a further frame subtracted on top
(`presentedFrameCount - 1 >`) that no comment explained. Measured over the
three runs `vr1`, `vr2` and `vr3` of the second verification round, no window came
closer than **4.46 frames** to tripping it — and that closest window,
`vr3`'s `tasks:scroll-left:1`, is the one that was called physically
impossible at 61.9 presented frames per second. It is not impossible: 18
instants need 17 gaps, 17 × 16.655 ms is 283 ms, and the window is 291 ms
long. A rate above the nominal refresh in a short window is the fencepost,
not a defect, and a bound that mistakes the two while sitting 4.46 frames
clear of every real window is decorative.

And 60 was a constant. On a 120 Hz display that constant rejects every window
longer than 67 ms; at 144 Hz it rejects all 38 motion windows of a real run;
below about 40 Hz it stops binding at all. The rate is in the data, and
`resolveRefreshHz` reads it there: the median of the gaps a single refresh
can occupy (5–30 ms, i.e. 33–200 Hz). Over twelve full runs on the reference
box that median lands between 16.600 and 16.716 ms — **59.82 to 60.24 Hz**
against a nominal 60 — and the estimate is trustworthy in proportion to how
much of it there is. Taking every contiguous slice of those runs and scoring
it against the whole run: worst error 4.40 Hz once 50 in-band gaps are
present, 1.70 Hz at 100, **0.84 Hz at 150**, 0.54 Hz at 200. Below 150 the
function refuses instead of guessing; a real 70-second recording supplies
782 to 888. A 26-instant excerpt, for the record, reads 61.5 Hz on hardware
that runs at 60.0.

What is left is one measured allowance. Genuine sub-refresh instants exist —
`STATE_PRESENTED_PARTIAL` frames that really are separate screen updates less
than a refresh apart — and a short window can hold a couple. Across twelve
full runs and every sliding 0.30 s, 0.50 s, 0.90 s, 1.50 s and 3.00 s stretch
of each, the instant count exceeds `floor(span × refreshHz) + 1` by at most
**2**, while the double-counting defect exceeded the old, looser line by 35
to 51. The allowance is 3, and the suite pins it from both sides: 64 instants
in a 1.000 s window pass, 65 fail, so loosening or tightening it by a single
frame fails a test. Round two's version could be loosened from 4 to 5 without
a single test objecting.

`presented.json` is written next to the other artifacts so the denominator
itself can be re-checked afterwards, and `capture-efficiency.json` now
carries the `refreshHz` the bound was computed from.

### The denominator's other end: a trace that lost events

The refresh bound is one-sided. A denominator that is too **small** moves
capture efficiency towards the gate rather than away from it — on `r2a`'s
numbers 84.2% becomes 88.5% at 5% denominator loss, 93.2% at 10% and 105.4%
at 20% — and no ratio built on that denominator can notice.

Chromium reports it, so it is read rather than inferred.
`Tracing.tracingComplete` carries `dataLossOccurred`
(`content/browser/devtools/protocol/tracing_handler.cc:698-706`), which is
set from Perfetto's own buffer statistics: `chunks_overwritten`,
`chunks_discarded`, `abi_violations` or `trace_writer_packet_loss` above zero
(`services/tracing/public/cpp/perfetto/perfetto_session.cc:39-49`). The final
statistics are requested after the last chunk has been streamed and before
the completion notification is sent (`tracing_handler.cc:518-529`, comment
"Request stats to check if data loss occurred"), so the flag covers the whole
recording. `extractPresentedFrameTimes` takes it as a required argument and
refuses the trace outright when it is set.

Two more paths could shrink the denominator silently, and both are now loud.
A `PipelineReporter` id opened twice used to keep the newer record and drop
the older one's instant — one lost instant per overlapping pair, so a trace
made entirely of such pairs would score half. Clock marks from two renderer
processes used to select whichever process the first mark happened to be in,
counting one renderer's presentations and losing the other's. Neither shape
occurs in any of 24 real traces, which is the reason they must not be guessed
at quietly rather than a reason to ignore them.

Both the presented and the painted timestamps are now required parameters of
`computeCaptureEfficiencyReport`. The optional one had already been misused:
`tests/capture.integration.test.ts` passed the paint ticks into the presented
slot while its own comment claimed otherwise, and it type-checked.

### What the finished video actually shows, and what causes it

Three product runs of this branch on the AI box against the patched Chromium
build (`vr1`, `vr2`, `vr3` of the second verification round, 2026-09-12), measured on
`output.mp4` by frame comparison over all scroll windows: **30.6%, 34.1% and
31.3%** of output frames show nothing new at the tightest threshold (0.05
mean grey levels), rising to 37.6%, 41.8% and 40.8% at the loosest (1.0).

The accounting below is built so its categories cannot overlap, and the
denominator is the same for every row: every output frame inside a scroll
window, compared against the frame before it, is assigned to exactly one of
them.

| cause                                                         | `vr1` | `vr2` | `vr3` |
| ------------------------------------------------------------- | ----- | ----- | ----- |
| the compositor presented nothing new in that 16.7 ms slot     | 5.3%  | 7.9%  | 6.6%  |
| it presented, but the capture never received the frame        | 19.9% | 21.1% | 20.0% |
| the capture received a new frame whose picture did not change | 5.3%  | 5.0%  | 4.7%  |
| a new picture                                                 | 69.4% | 65.9% | 68.7% |
| denominator (output frames in scroll windows)                 | 487   | 478   | 485   |

The disjointness is by construction rather than by claim: a slot that reuses
the previous source frame cannot show a new picture, and the first two rows
partition exactly those slots by whether a presentation instant fell inside
them. The previous version of this table did claim it, and was wrong. It
counted the ceiling as "no presentation instant in this slot" without
requiring the slot to be a repeat, so slots that advanced the source frame
and visibly changed were charged to the compositor: `r2b` slot 2041 advanced
from source frame 770 to 771 and changed 449 537 pixels. On the three runs
above that same overlap covers **21, 74 and 27 slots** — and the old table's
`10.4%` row was computed over 450 output slots while its other three rows
were computed over 464, so its adding up to 100.0% was arithmetic luck.

The second row is this pipeline's own loss and the largest fixable part.

**The loss is not load-dependent, which is what makes it diagnosable.** The
earlier claim that it was rested on a spread of 84.2 / 87.1 / 81.6% across
three runs and one older run at 98.1%. Measured against load directly, three
product runs scored 80.2% at load 17, 81.9% at load 2 and 82.1% at load 20 —
no dependence, and the spread is run-to-run noise. The loss is stable and
concentrated: the sort windows capture 1–2 of 15–17 presentations, and the
right-scroll reproducibly 4 of 13–14. That is a finding for ticket 17, not weather.

### Acceptance point 1 belongs to the frame supply, not to this document

The ticket asks for under 10% unchanged output frames. The ceiling on that —
the share of output slots in which Chromium presented nothing at all, i.e.
what the run would still repeat with a perfect capture **and** a perfect
clock — is **9.7%, 23.4% and 12.2%** on the three runs above, and 8.4 / 10.4 /
11.5 / 12.1 / 19.5 / 23.0% over six runs measured independently. One of six
is under 10%.

So in most runs the target is not reachable by any change to the timeline or
to the capture path. How many frames arrive at all is decided by the frame
supplier, which is ticket 17 and ticket 2. This ticket delivers the timebase and an
honest measuring instrument; it does not deliver that number, and no version
of it will.

### Re-basing the timeline onto the presentation times: rejected, then the rejection withdrawn

The obvious remaining suspect was the clock. `metadata.timestamp` is an
arrival stamp, arrival jitter is a few milliseconds, and the output grid is
16.7 ms wide — so two frames presented one refresh apart can land in one
output slot, and some other slot repeats. Modelled as slot occupancy the
effect looks large: placing each captured frame on the latest presentation
instant at or before its arrival takes the empty-slot share from 32.9% to
23.1% on `r2b` and from 27.8% to 20.6% on `r2c`.

Round two built that, measured the finished videos, found them **worse**
(`r2b` 21.8% → 28.5%, `vt1` 23.5% → 25.2%) and concluded that the slot model
is wrong. **Both halves of that conclusion have since been withdrawn, and the
experiment behind them does not support anything.**

The experiment was not the controlled comparison it described itself as. Its
own manifest went from 1581 `file` lines to 1541: the re-basing **deleted 40
frames** before ffmpeg ever ran, each of them the earlier partner of a shared
presentation instant, and the implementation named that `foldedFrameCount`
while its guard let the run through. A second, independent loss on top:
presentation instants sit on the 60 Hz grid themselves, 435 of 1540 landed on
a slot boundary, and the collisions inside the scroll windows rose from 0 to
35 at identical frame count — surviving distinct source frames in those
windows fell from 354 to 308. "Same frames, same encoder, same command, only
the timestamps changed" was literally untrue.

The model it was used to refute is also wrong in the other direction.
`fps=60` **does** delete frames that share an output slot, and it keeps the
**later** one. Measured through exactly the production chain — 32 source
images each carrying its index as a five-bit barcode, concat demuxer,
`option framerate 1000`, `fps=60`, libx264, so it is known frame by frame
which source image reaches which output slot
(`verify-r2-fpsprobe2.sh` in the measurement workspace on the box):

| case                   | result                                        |
| ---------------------- | --------------------------------------------- |
| even 16.667 ms spacing | 24 output frames, identity, nothing lost      |
| two frames in one slot | **source frame 2 appears in no output frame** |
| realistic jitter       | **source frames 1 and 8 deleted entirely**    |
| a 55 ms hole           | frame 3 repeated three times, nothing lost    |

So "re-basing does not help" is unproven, not disproven, and the lever is
still open. It is deliberately not pursued here: this ticket is the timebase
and the measuring instrument, and re-opening the re-basing needs a controlled
experiment that does not lose frames on the way in. A finer ffconcat timebase
(`option framerate 1000000` instead of `1000`) moved each timeline by about a
point in opposite directions, so 1 ms quantisation is not the cause of
anything either way.

### The exact mapping exists, and needs the patch

For the record, because the next attempt will find it: Chromium writes the
presentation time of every _captured_ frame into the same trace, as
`Capture` events in category `gpu.capture` carrying `frame_number` and
`timestamp_micros`. On the patched build the books balance exactly —
capture events equal delivered frames plus folded duplicates, difference
**0** on all three repeats (1607, 1634, 1608). On the stock and unpatched
builds they do not: Chromium discards 70 to 110 frames it had already
captured (`stock` 70/77, `unpatched` 92/104/110), so a mapping built there
would silently move content in time. The exact mapping is therefore
available only behind ticket 17's patch. Whether it would buy anything is open: the
one experiment that said no deleted 40 frames on its way in.

## Which half of the patch earns the yield (added 2026-09-17)

The patched build carries two changes, and until this measurement the whole
84 % → 99.6 % difference was attributed to the first of them. It is the second.

Four arms, three repeats each, interleaved per repeat so machine drift hits
every arm equally. Same device (`desktop`), same capture area 2560×1600, same
script `demo/fixture-tour.ts`, `--passes 2`, one run at a time on the RTX 3090
box, ANGLE GL, Chromium 153.0.8010.12 from the patched tree. Switching an arm is
an incremental rebuild of two translation units plus the link, 46-55 s — no full
build was triggered.

| arm | `SetAnimationFpsLockIn(false)` | frames in flight | r1     | r2     | r3     | mean       | captured/presented | 95 % gate |
| --- | ------------------------------ | ---------------- | ------ | ------ | ------ | ---------- | ------------------ | --------- |
| A   | applied                        | 12               | 98.8 % | 98.8 % | 98.5 % | **98.7 %** | 338 / 342          | pass ×3   |
| B   | applied                        | 2 (stock)        | 87.4 % | 91.2 % | 88.3 % | **89.0 %** | 299-312 / 342      | fail ×3   |
| C   | reverted                       | 12               | 98.8 % | 98.8 % | 98.8 % | **98.8 %** | 338 / 342          | pass ×3   |
| D   | reverted                       | 2 (stock)        | 92.4 % | 87.1 % | 83.6 % | **87.7 %** | 286-316 / 342      | fail ×3   |

Contributions from the means: the in-flight limit alone +11.1 points (D→C), the
sampler change alone +1.3 points (D→B), both together +11.0 points (D→A). There
is no interaction — A and C are indistinguishable.

**The spread carries as much of the finding as the mean.** A and C captured
exactly 338 frames in all six runs; B and D scattered between 286 and 316, and
in repeat 1 B (87.4 %) landed _below_ D (92.4 %). Raising the in-flight limit
does not merely lift the average, it moves the capture from a random ceiling to
a fixed one. The sampler change on its own is not distinguishable from zero at
this capture area — mechanically plausible, since it offers more frames into a
pipe that is already blocked at two frames in flight.

**Neither change produces the cadence.** Median inter-frame interval is
16.71-16.90 ms in every arm, full-cadence share 80.4-87.7 %, and `refreshHz`
stays between 59.68 and 60.12 across all twelve runs. The 60 Hz comes from the
page.

**Instrument check.** The same cadence script run against the reference capture
from the same day reproduces its published values exactly
(`median=16.76 ms`, `full12-21=84.8 %`, `dbl28-40=6.7 %`), so the instrument
moves and agrees with an outside anchor.

### What this does not say

It does not say the sampler change is useless, and no sentence anywhere should.
It was built for the visible judder during sideways scrolling; yield is the
wrong instrument for that, because an arm can deliver every frame and still
judder. The lock-in mechanism itself is not in doubt — it was traced directly
(see "Trace: presented vs captured frames" above, where `FpsRateLimited` refuses
every presented frame for the first ~240 ms of a horizontal scroll). What is
unmeasured is whether switching it off improves the finished picture. Until that
is measured with a smoothness instrument rather than a yield one, the honest
statement is: **unnecessary for yield, unproven for the picture.**

Three further limits: only 2560×1600 desktop, only `demo/fixture-tour.ts` (and
whether that tour even sustains animation in a single damage region is itself
unverified), and three repeats on one machine — enough to see a spread, not
enough to be statistically load-bearing.

### Consequence for the fork

In the pinned tree `Page.startScreencast` has no in-flight parameter (its list
ends at `everyNthFrame`) and the value is fixed at
`content/browser/devtools/protocol/page_handler.cc:98`. On Chromium `main` it is
`optional integer maxFramesInFlight`, documented as defaulting to 3, with the
constant replaced by a validated accessor. `SetAnimationFpsLockIn` still has no
caller in `devtools_video_consumer.cc` on `main`.

So the fork's yield half has an upstream replacement waiting, and the other half
does not — and now also has no number behind it.

The twelve runs, the per-arm driver and the restore check live in the
measurement workspace on the AI box, a scratch directory next to this checkout
and not part of this repository: `halves.sh`, `halves.log`, `cadence.py`, and
`artifacts/half-{A,B,C,D}[-r2,-r3]` plus `artifacts/half-restore-check`, each
carrying its own `capture-efficiency.json`, `presented.json` and `browser.json`.
After the last arm the tree was restored to both changes (`git diff --stat`:
2 files, 6 insertions, 1 deletion) and a control run confirmed 98.8 %.

## Reaching the bound without a fork (added 2026-09-17)

The measurement above leaves the fork's yield half resting on a recompiled
constant. It does not have to: `maxFramesInFlight` is an official parameter of
`Page.startScreencast` from Chromium 154 on. Playwright's `page.screencast`
does not pass it — its Chromium delegate sends `format`, `quality`, `maxWidth`
and `maxHeight` and nothing else — so `src/screencast-cdp.ts` drives the
screencast over a raw CDP session instead.

Measured against **stock Chrome for Testing 154.0.8037.0**, no patch, no
self-built browser, same box, same script and same capture area as the four-arm
measurement, three repeats interleaved between the two values:

| `maxFramesInFlight`             | r1     | r2     | r3     | mean       | captured/presented     | 95 % gate |
| ------------------------------- | ------ | ------ | ------ | ---------- | ---------------------- | --------- |
| 3 (Chromium's own default)      | 89.5 % | 82.2 % | 88.0 % | **86.6 %** | 281-306 / 342          | fail ×3   |
| 12 (what the patch compiled in) | 98.8 % | 98.8 % | 98.8 % | **98.8 %** | 338 / 342, three times | pass ×3   |

**An unmodified browser reaches the patched build's number exactly.** 338 of
342 in every run, the same figure all six patched arms produced, the same
duplicate count. For capture yield the fork is now replaceable by a protocol
parameter — the remaining reason to build it is the animated-content lock-in,
which this project has still never measured against a metric that could see it.

**And the default costs 12.2 points.** That is the figure an upstream request
needs, and it is now measured against the documented default of 3 rather than
against the 2 the pinned tree compiled in.

Nothing between 3 and 12 has been measured, so 12 is the proven value rather
than the known optimum.

### How the capture knows whether it got the bound

Not from the version string: `src/browser.ts` records why that witness is
unusable — a patched and an unpatched build report the same version, and
attributing a measurement to the wrong one has already cost this project three
days. Not from the protocol definition either: that lives on the browser's
DevTools HTTP endpoint, and Playwright launches Chromium over a pipe.

So the command is asked directly. Measured against Chrome for Testing
153.0.8010.47 and 154.0.8037.0:

| sent to `Page.startScreencast`         | 153      | 154                                   |
| -------------------------------------- | -------- | ------------------------------------- |
| `maxFramesInFlight: 12`                | resolves | resolves                              |
| `maxFramesInFlight: 0`                 | resolves | rejects, "must be a positive integer" |
| `maxFramesInFlight: "x"`               | resolves | rejects, "Invalid parameters"         |
| a parameter that does not exist at all | resolves | resolves                              |

The last row is what makes this sound rather than lucky: 153 swallows anything
it does not recognise, so a rejection can only come from a browser that
recognises this one. A capture reports what it resolved to, and
`demo/yield-bench.ts` refuses to print a yield number when the answer is "the
browser has no such parameter" — the recording is fine, a number from an
unknown regime is not.
