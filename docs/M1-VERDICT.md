# M1 verdict: the capture is not accepted, and the reason is structural

Date: 2026-09-11. Subject: `artifacts/m1-008/output.mp4` (1920×1080, constant
60 fps, 62.78 s, ffprobe in `artifacts/m1-008/ffprobe.txt`), recorded on the
RTX 3090 box from the real UI of the recorded application.

## The owner watched it

Verdict: **vertical scrolling is smooth, horizontal scrolling visibly
hitches, reproducibly.** That is the acceptance criterion of issue #2 ("the
result is watched"), and it fails.

The comparison against a Screen Studio recording of the same UI was **not**
carried out. It would not change the outcome: the defect is visible without a
reference, and its mechanism is proven independently of any comparison.

## Why sharpness is not the open question

The milestone's original risk was that downscaling 2560×1600 to 1920×1080
would not look sharp. That risk did not materialise: text is sharp, and the
stills at `docs/stills/` show it at both capture sizes. The milestone fails on
cadence, not on sharpness.

## What the eye saw, in numbers

The measured capture efficiency gate sits at 84-86% against a 95% floor
(`artifacts/m1-008/runs/accept-r{1,2,3}.json`). The loss concentrates in three
windows: the first horizontal scroll after the vertical passes, the sort
click, and the dark-mode transition. The visible hitch and the measured gap
are the same event: in the trace `presented-t1`, every frame Chromium
presented between 70 ms and 223 ms of the horizontal-scroll window was refused
by the capturer, and the first captured frame arrived at 236 ms.

So the 95% floor is not too strict. It predicted a defect that the eye then
confirmed.

## Mechanism (see `docs/CAPTURE-CADENCE.md`, mechanisms 3 and 4)

1. Chromium's `AnimatedContentSampler` locks onto one damage region after ~1 s
   of animation and refuses frames whose damage rect differs, for up to
   250 ms. The vertical passes lock it in; the horizontal scroll right after
   damages a different region and is refused. This is `crbug.com/391118566`; a
   fix landed upstream and was reverted in M135.
2. A second, smaller loss is DevTools' limit of two unacknowledged frames in
   flight, which mainly costs the dark-mode transition.

Neither is reachable from our side through the CDP screencast: the mojo
opt-out `SetAnimationFpsLockIn` exists, but Chromium's DevTools video consumer
never calls it, and no launch flag or CDP parameter does either (verified at
the pinned Chromium 153.0.8010.12 across 108 files).

JPEG quality is not a lever: 85 and 80 measure the same as 90.

## Consequence

M1's pipeline — oversized capture, real timestamps, assembly to constant
60 fps, the hardware-renderer assertion, the repeat/freeze detection and the
efficiency gate — is sound and stays. **The frame source underneath it has to
change.** The capture path moves off the real-time CDP screencast; the
measured candidates and the decision are tracked in the follow-up issue
referenced from #2.

This document records the visual verdict. It does not close #2: the milestone
is accepted only when a recording of the same UI, through the new frame
source, passes the same gate and is watched again.
