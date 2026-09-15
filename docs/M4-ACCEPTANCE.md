# M4 acceptance: the chain produced a finished video, and here are its numbers

Date: 2026-09-15. Run on the RTX 3090 box, patched Chromium, container
`featurecast-box:1`, against the real OnlyDash guest UI.

Everything below is **measured** — a command ran and its output is quoted —
except the one line marked otherwise. The owner's verdict on how it _looks_ is
not here, because it has not been given yet; that line is what closes #5.

## What ran

```
tsx src/cli.ts run demo/m4-acceptance.ts --devices desktop-wide --out /out/run1
tsx src/render/cli.ts /out/run1/desktop-wide /out/render1
```

The recording is 20.74s of wall clock and writes 117 source frames — not a
defect but the design: the capture folds bit-identical consecutive frames, and
between two interactions this application does not change a pixel. The pointer
moves at 60Hz anyway, because the renderer draws it from the event log rather
than reading it out of the picture.

## The three criteria of #5

**Three formats out of one raw material, without a second browser run.** One
render call, 16.6s wall clock, three files. `ffprobe` on each: constant 60fps,
`yuv420p`, 1041 frames, 17.35s.

| Format | Delivered    | Asked for |
| ------ | ------------ | --------- |
| 16:9   | 1920x1080    | 1920x1080 |
| 1:1    | 1080x1080    | 1080x1080 |
| 9:16   | **900x1600** | 1080x1920 |

The portrait number is the promise being kept rather than broken: the largest
9:16 rectangle inside a 2560x1600 capture is 900x1600, and the renderer says so
in its output instead of upscaling. Sharp portrait needs a portrait recording,
which is M3.

**The zoom frames the element that was hit.** Checked against the log rather
than by eye: every shot's crop in every format contains the bounding box of the
interaction it belongs to. Three interactions carry a box; the click and the
typing land on the same element at the same tick and merge into one shot, so
16:9 and 1:1 each carry two shots and 9:16 two.

**A look parameter changes and the result is back in under two minutes.**
Measured: **9.1 seconds** for a re-render at 16:9 with a larger pointer, a
longer ripple and less padding. And the determinism claim holds with it — two
renders of the same decision data produced the same file, `sha256` equal.

## What the run revealed about the product

**At this preset the camera has almost no room to move.** A 2560x1600 capture
delivered at 1920x1080 is already 1.33x, and that is the whole zoom budget. The
dark-mode button is 32x32 and wanted 4.62x; it got 1.33x. The search box wanted
4.27x and got the same. The renderer reports each clamp by name, so nothing is
silent — but a viewer will see a camera that drifts rather than one that pushes
in.

That is not a bug in the zoom. It is the arithmetic of over-capturing: the same
margin that buys three formats and sharp text is the margin the zoom would have
had to spend. A visible push-in needs either a larger capture or a smaller
output, and which of the two is a product decision, not a defect to fix.

## What is not proven here

The video has not been watched by the owner. Sharpness, pacing and whether the
drawn pointer reads as a pointer are all open until it has been.

Material: `artifacts/m4-acceptance/` on the workstation — the three formats, and
a labelled side-by-side of two looks at one fifth speed for judging motion.
