# Capture cadence: resolution, quality, GPU backend, and content

Measured 2026-09-11, revised the same day after an independent review found
the first version's methodology and conclusion both wrong. **Corrected
finding: the 2560×1600 default now sustains ~60fps on a dense page and is
kept as-is** — the fix was the GPU backend, not the resolution.

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

**With the hardware GL backend, the dense fixture at the default
2560×1600/q100 sustains 59.2fps capture / 60.0fps rAF — full rate.** The
quality effect that looked "noise-level" in the first version (25–29fps
across q70–q100) was itself an artifact of both the short sample window
and software rendering; at 10s samples under software rendering it is
q100=28.5 vs q80=32.5 (+14%), not negligible, but the whole comparison is
moot once hardware GL is used (q100 and q80 both land at ~57–60fps).

Real M1 acceptance run (`artifacts/m1-002`, before this fix, OnlyDash live
dashboard) landed at 314 source frames over 29.75s, median 59.1ms
(~17fps) — far below even the software-rendering numbers here, because
`m1-002` additionally suffered from the dead-scroll-pass bug (see the
main report): frames that never arrived at all during two ~4.7s stretches
with zero repaints, not just a slow renderer. `artifacts/m1-003` (this
fix plus the benchmark fix) is the number to compare against this table.

## Is it encoding or layout? (superseded)

The first version's "layout, not encoding" conclusion used the same
detached-rAF methodology and is superseded by the GPU-backend finding
above: the dominant cost is per-frame surface capture under software
rasterization at the CSS-viewport resolution, not layout/paint time
itself (rAF-attached at 2560×1600 dense/software was still 31.4fps —
consistent with software-rasterized surface readback costing roughly
CSS-viewport-area time, not with a fundamentally expensive DOM layout,
since the DOM does not change between the GL backends and the same
viewport reaches ~60fps once hardware GL handles that readback).

## Sharpness

Unchanged conclusion, re-verified with the hardware-GL stills committed
at `docs/stills/cadence-2560x1600-q100.png` and
`docs/stills/cadence-1920x1200-q100.png`: both render sharp, readable
text with no visible scaling blur; 2560×1600 fits more table columns at
the same on-screen text size (PLAN.md's 1.33× zoom-reserve reasoning).

## Recommendation

**Keep 2560×1600/q100.** With the hardware GL backend from `renderer.ts`
wired into `demo/m1-capture.ts`, it sustains ~60fps on a dense,
actively-repainting page — there is no cadence reason left to trade away
resolution. The real lever was the GPU backend, not the capture
resolution; `assertHardwareRenderer` makes a future regression back to
software rendering a loud failure instead of a silent 17–30fps capture
that still passes every duration/frame-count check.

JPEG quality (q80 vs q100) has a small, now-genuinely-negligible effect
once hardware GL is in use (57.3 vs 59.2fps); q100 stays the default for
maximum sharpness since cadence is no longer the constraint.

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
