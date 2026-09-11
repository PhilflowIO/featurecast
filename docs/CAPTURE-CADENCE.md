# Capture cadence: resolution, quality, and content

Measured 2026-09-11 in response to a red-team finding: PLAN.md's "60 fps at
2560×1600" claim was measured against light test pages, and does not hold
for a dense, real, actively-repainting UI. This document is the evidence
for that trade-off; the 2560×1600 default is **not** changed here — that is
the owner's decision to make, not something this doc decides on its own.

## Method

`page.screencast.start({ onFrame, quality, size })` measured directly
(no disk writer in the loop, so these numbers isolate the browser/CDP
capture cost from `captureScreencast`'s write pipeline) for 2.5s per
configuration, against two fixture pages:

- **dense**: a 70×18 table (1260 cells) with a 3s vertical CSS-transform
  scroll animation and per-cell inline styles — stands in for a real,
  actively-repainting data grid. The same fixture `dense-probe2.mts` used
  to first measure this.
- **light**: the single sliding `<div>` used by
  `tests/capture.integration.test.ts`.

Page paint rate (`requestAnimationFrame` counter, no screencast attached)
was measured once per page × size as the ceiling: what the page could do if
capture cost were zero.

Full raw numbers: `table.md` and the extracted stills referenced below live
in `/tmp/claude-1000/-home-philflow-Dokumente-coding-featurecast/cce358a0-d205-4419-a07f-0f8a73bea496/scratchpad/m1-verify/matrix/`
(scratch, not committed — this document is the durable record).

## Results

Page paint rate (no screencast attached) was **60fps for every
page × size combination** — the browser itself is never the bottleneck;
capture always is.

| page  | capture size | quality | capture fps | median interval | p95 interval | median frame size |
| ----- | ------------ | ------- | ----------- | --------------- | ------------ | ----------------- |
| dense | 2560×1600    | 100     | 26.3        | 38.0ms          | 102.1ms      | 2985 KB           |
| dense | 2560×1600    | 90      | 25.4        | 39.4ms          | 50.6ms       | 1447 KB           |
| dense | 2560×1600    | 80      | 25.7        | 38.9ms          | 74.3ms       | 1057 KB           |
| dense | 2560×1600    | 70      | 29.0        | 34.5ms          | 50.0ms       | 869 KB            |
| dense | 1920×1200    | 100     | 45.8        | 21.8ms          | 59.9ms       | 1676 KB           |
| dense | 1920×1200    | 90      | 48.9        | 20.5ms          | 37.1ms       | 811 KB            |
| dense | 1920×1200    | 80      | 50.1        | 19.9ms          | 34.1ms       | 591 KB            |
| dense | 1920×1200    | 70      | 59.8        | 16.7ms          | 26.2ms       | 488 KB            |
| dense | 1280×800     | 100     | 59.0        | 17.0ms          | 23.8ms       | 741 KB            |
| dense | 1280×800     | 90      | 60.3        | 16.6ms          | 19.2ms       | 359 KB            |
| dense | 1280×800     | 80      | 60.3        | 16.6ms          | 18.1ms       | 261 KB            |
| dense | 1280×800     | 70      | 59.9        | 16.7ms          | 18.2ms       | 215 KB            |
| light | 2560×1600    | 100     | 60.7        | 16.5ms          | 19.1ms       | 25 KB             |
| light | 1920×1200    | 100     | 60.8        | 16.4ms          | 22.2ms       | 15 KB             |
| light | 1280×800     | 100     | 60.1        | 16.6ms          | 20.2ms       | 7 KB              |

(light-page quality variants all land at 59–63fps regardless of quality —
omitted for brevity, see `table.md` for all 24 rows.)

Real M1 acceptance run (`artifacts/m1-002`, OnlyDash live dashboard, dense
grid + 43-entry sidebar under continuous scroll) landed at **314 source
frames over 29.75s** — median 59.1ms interval (~17fps), 0% of gaps ≤20ms
during the recorded motion. That is worse than this matrix's synthetic
`dense` fixture (25.7fps median at 2560×1600/q80), consistent with the real
grid (11 rows × 9 columns, MUI DataGrid virtualization + sticky headers +
horizontal scrollbar) being _more_ expensive to repaint than the synthetic
table.

## Is it encoding or layout?

Tested explicitly: same 2560×1600 CSS viewport (so layout/paint cost is
unchanged), but a smaller **screencast size** (so only the JPEG
encode+transfer is cheaper):

| CSS viewport                 | screencast size                    | fps  | median frame size |
| ---------------------------- | ---------------------------------- | ---- | ----------------- |
| 2560×1600                    | 2560×1600 (native)                 | 26.3 | 2985 KB           |
| 2560×1600                    | 1920×1200 (downsized capture only) | 27.1 | 1882 KB           |
| 2560×1600                    | 1280×800 (downsized capture only)  | 36.1 | 946 KB            |
| _(for comparison)_ 1920×1200 | 1920×1200 (native)                 | 45.8 | 1676 KB           |
| _(for comparison)_ 1280×800  | 1280×800 (native)                  | 59.0 | 741 KB            |

Shrinking only the screencast output barely moves fps (26.3 → 27.1 at
1920×1200; 26.3 → 36.1 at 1280×800), while shrinking the **CSS viewport**
to match moves it to 45.8 and 59.0 respectively. **The bottleneck is
layout/paint at the full 2560×1600 viewport, not JPEG encoding.** A
"capture small, render big" compromise that keeps the viewport at
2560×1600 and only asks for a smaller screencast frame does not help.

## Sharpness

Stills extracted from the last captured frame of each configuration,
pushed through the real render pipeline's crop+scale
(`crop=W:round(W*9/16):0:offset,scale=1920:1080:flags=lanczos` for
W≥1920; 1280×800 does not qualify for the "never upscale" rule and was
left at its native 1280×720 crop for comparison only, not as a candidate).
Visual check (2560×1600→1920×1080 vs. native 1920×1200→1920×1080, both
q100): both render sharp, readable text with no visible scaling blur.
2560×1600 fits noticeably more table columns in frame at the same on-screen
text size (matches PLAN.md's 1.33× zoom-reserve reasoning); 1920×1200 shows
fewer columns but is otherwise indistinguishable in sharpness. 1280×800
text is legible at its native size but the frame is a poor match for the
final 1920×1080 canvas (upscale territory) and was not seriously considered
regardless of its favorable fps.

## Recommendation

Capture size is a direct trade-off against fps on real UI, and it is
layout-bound: **1920×1200 roughly doubles dense-page fps over 2560×1600**
(45.8 vs 26.3 at q100) while still downscaling cleanly to 1920×1080 with no
upscale and no visible sharpness loss in this test. 1280×800 reaches
near-60fps even on the dense fixture but requires upscaling to the 1920×1080
canvas, which PLAN.md already rules out ("Zoom ist ein Ausschnitt aus dem
Original, nie eine Vergrößerung") and there is no reason the base capture
size should be exempt from the same rule.

JPEG quality has a smaller, less consistent effect (roughly 25–29fps across
q70–q100 at 2560×1600 on the dense fixture — noise-level compared to the
resolution effect) but a large effect on frame size and therefore on
`capture-stats.json`'s duplicate/writer-load numbers; q80–q90 looks like a
reasonable default independent of the resolution decision.

**This is presented as a finding and a recommendation, not a change**: the
current default stays 2560×1600/q100 until the owner decides. If the
decision is to trade some spatial density for cadence, 1920×1200 is the
evidence-backed alternative; if 2560×1600 is kept, the realistic expectation
for a dense, actively-repainting UI is ~25–30fps at q80–100, not 60fps —
`capture-stats.json`'s per-run cadence numbers are the way to verify that
expectation against reality run over run, not the M1 gate accepting a
capture that fell short of it.
