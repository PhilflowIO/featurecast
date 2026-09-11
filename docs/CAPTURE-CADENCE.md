# Capture cadence: resolution, quality, GPU backend, and content

Measured 2026-09-11, revised twice the same day after independent reviews
each found a methodology error. **Current finding: capture cadence is
governed by two independent constraints — the GPU backend (fixed, see
below) and a hard ~80MB/s screencast throughput ceiling (a property of the
pipe, not fixable by this codebase) — and the 2560×1600/q100 default stays
because OnlyDash's real frames are small enough to fit inside it, not
because 2560×1600/q100 is fast in general.**

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

Raw numbers: `table.md` in
`/tmp/claude-1000/-home-philflow-Dokumente-coding-featurecast/cce358a0-d205-4419-a07f-0f8a73bea496/scratchpad/m1-verify/matrix-v2/`
(scratch). Comparison stills are committed at `docs/stills/` (see below).

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
reached** — lower resolution, lower quality, or (as with OnlyDash) content
that simply compresses smaller than a synthetic worst case. OnlyDash's
real frames average 408KB in the `artifacts/m1-003` acceptance run — well
under the 1.3MB budget — which is _why_ 2560×1600/q100 reaches ~54fps on
real OnlyDash content despite this synthetic dense-table probe topping out
at 25fps at the same size/quality. The earlier "2560×1600/q100 sustains
60fps" claim was true for OnlyDash specifically and false as a general
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

**Keep 2560×1600/q100 as the default, but on the record that this is a
content-dependent decision, not a resolution-independent one.** Two
independent constraints govern cadence: the GPU backend (fixed by
`renderer.ts` — `assertHardwareRenderer` makes a regression back to
software rendering a loud failure instead of a silent 17-31fps capture
that still passes every duration/frame-count check) and a hard ~80MB/s
screencast throughput ceiling that no backend or resolution choice
removes. 2560×1600/q100 stays because OnlyDash's real frames (408KB mean)
fit comfortably under the ~1.3MB budget that ceiling implies at 60fps —
not because 2560×1600/q100 is fast in general (the synthetic dense-table
probe above tops out at 25fps at that exact size/quality).

If a future target app's frames are heavier (more colorful, less
whitespace, higher-entropy content that compresses worse — the exact
opposite of what makes OnlyDash's frames small), the same 2560×1600/q100
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
OnlyDash Tasks view delivers ~58-60 content changes/s while scrolling — the
app was never the bottleneck; both the wrong scroll target and this
workstation's weaker iGPU were. The paragraph immediately below (the
~14fps/~69%-loss number) is **workstation-only** and reflects that iGPU,
not a property of OnlyDash. See "AI-box acceptance run" further down for
the corrected, decisive numbers.

**Where the loss actually is (workstation, iGPU).** Measured directly
against real OnlyDash `tasks`-grid scrolling on this box: the page painted
~21fps (in-page rAF, screencast attached, using the since-corrected scroll
target) while this pipeline only captured ~14fps of it — a real ~69%
efficiency loss on this hardware, not a page-paint-rate problem general to
OnlyDash. Isolating the cause with
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
slower ones. **Real OnlyDash frames during scroll (615-660KB median,
comparable to this table's q70 row) would predict near-full efficiency from
byte size alone** — the measured 45-86% loss during real DOM churn
(`artifacts/m1-006`/`m1-007`) is therefore not explained by frame size on
its own; DOM-churn CPU cost and encode CPU cost both draw on the same
budget and compound. Both are upstream of `capture.ts`.

## PLAN.md / docs/DEVICES.md divergence (unresolved, flagged for the owner)

Fixing the crop-shears-the-toolbar defect (see the main report, item 5)
surfaced an existing disagreement between the two docs that this task did
not resolve: PLAN.md specifies capturing 2560×1600 (16:10) and cropping to
16:9 for a deliberate 1.33× zoom reserve; `docs/DEVICES.md` already lists
2560×1440 (16:9 natively, no crop) as the desktop preset. `src/assemble.ts`
currently follows PLAN.md (capture 1600, crop to 1440) with the crop now
anchored top instead of centered. Whether the zoom reserve is worth the
extra capture height (more pixels to rasterize, though no longer the
bottleneck per this document) versus DEVICES.md's simpler native-16:9
capture is an open product decision, not something this fix decided.
