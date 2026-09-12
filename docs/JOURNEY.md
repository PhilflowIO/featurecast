# Journey: the hunt for the hitch

What this document is: the chronicle of one defect — the owner watched a
recording and the horizontal scroll hitched — and of everything that was
believed, measured, disproven and corrected on the way to its cause.

**Code is truth. This document is orientation.** Where a claim here and the
code disagree, the code wins and this document is wrong. Sections are dated
and appended. Superseded statements are **left standing and marked**, not
deleted — several of the wrong turns below looked completely convincing at the
time, and the record of _why_ they looked convincing is the useful part.

Mechanisms live in [`CAPTURE-CADENCE.md`](./CAPTURE-CADENCE.md), the visual
verdict in [`M1-VERDICT.md`](./M1-VERDICT.md). This file does not restate
them; it says what happened, in order, and which issue holds the detail.

---

## 2026-09-11 — the verdict that started it

The owner watched `artifacts/m1-008/output.mp4`, recorded from the real
OnlyDash UI on the RTX 3090 box. Verdict: **vertical scrolling is smooth,
horizontal scrolling visibly hitches, reproducibly.** That is the acceptance
criterion of #2, and it failed. Full reasoning in
[`M1-VERDICT.md`](./M1-VERDICT.md).

Two things were already clear and have survived everything since:

- The milestone did **not** fail on sharpness, which was the original risk.
  Downscaling 2560×1600 to 1920×1080 looks fine.
- The pipeline around the frame source — oversized capture, real timestamps,
  assembly to constant 60 fps, repeat detection, the efficiency gate — is
  sound. **The frame source underneath it was the problem.**

---

## 2026-09-11/12 — three days of measuring the wrong thing, and why

Measurement concentrated on _capture efficiency_: of the frames Chromium put
on screen, how many did we receive. The number hovered around 80–86 % and
would not move. Enormous effort went into explaining an 18 % loss.

Two mechanisms were found and are real (detail in #17):

1. **Chromium's `AnimatedContentSampler`** locks onto one damage rectangle
   after ~1 s of animation and refuses frames whose rectangle differs, for up
   to 250 ms (`animated_content_sampler.cc:100` compares for _exact_
   equality; re-detection needs a 1–2 s observation window,
   `animated_content_sampler.cc:27-28`). The vertical passes lock it in; the
   horizontal scroll that follows damages a different rectangle and every one
   of its frames is refused. The 0.32 s window is far too short to recover.
   This is `crbug.com/391118566`; the upstream fix landed and was reverted in
   M135.
2. **DevTools held at most two unacknowledged frames in flight**
   (`page_handler.cc:98`). At 2560×1600, encode plus transfer plus
   acknowledgement does not fit in one frame interval.

Both were fixed in a self-built Chromium (`SetAnimationFpsLockIn(false, 1.0f)`
in `devtools_video_consumer.cc`; the in-flight limit raised to 12). Both
patches are load-bearing and they fix different things: patch 1 restores the
right-scroll and leaves the overall rate untouched, patch 2 lifts the overall
rate from ~31 to ~50 frames/s. Taking one without the other fixes half.

### The measuring instruments were wrong twice, and neither time did the tests catch it

This is the recurring failure mode of this project, and it is worth stating
plainly because it has now happened twice with the same shape:

- **`src/paint-rate.ts`** counted a vsync tick as "painted" as soon as a
  `scroll` event had fired. It runs on the renderer main thread while smooth
  scrolling is driven by the compositor thread, so it undercounted
  systematically _during exactly the windows under investigation_. An
  undercounting denominator makes the ratio read better the worse things get.
  It was caught by a ratio of **100.9 %** — physically impossible.
- **The first version of `src/presented.ts`** counted Chromium's trace
  _notifications_ instead of actual presentation instants, roughly 1.5× too
  many. It was caught by **89.8 presented frames per second on a 60 Hz
  display** — physically impossible.

In both cases the project's own green test suite passed. In both cases the
thing that caught the error was an **external anchor**: a bound that does not
come from the same calculation it is checking. That lesson is now a
requirement on every instrument this project builds (#24).

> **Superseded:** earlier comments on #17 and #21 quote **86.7 %** for the
> right-scroll. That figure comes from the broken `paint-rate` denominator.
> Percentages measured against the old denominator are comparable _among
> themselves_ — the Playwright ↔ unpatched ↔ patched comparison used one
> consistent yardstick and still holds — but they are not valid as absolute
> levels.

---

## 2026-09-12 — the capture clock (#21, merged as #22)

Screencast frame timestamps sometimes step backwards. The assembler clamped a
backwards timestamp forward onto its predecessor, which produced 37–42
zero-length gaps per run. ffmpeg resolves two frames sharing one output slot
by keeping the _later_ one — so those clamped frames were deleted from the
video after having been captured successfully. Proven with a barcode probe
through the real production chain.

Fixed by sorting on capture order instead of clamping; confirmed at the pixel
level (12:0 in favour of capture-order sorting).

Still open on #21, deliberately: **re-basing the timeline onto Chromium's real
presentation times is rejected but _unproven_**. The counter-experiment that
rejected it had a bug of its own and lost 40 frames before the encoder ran.
The lever is open; it was simply not the question at hand.

---

## 2026-09-12 — the correction that invalidated three days of numbers (#23)

Two sets of runs, same source revision, same machine, reported **80–82 %** and
**98–99 %** capture efficiency. Both were believed to be the patched build.

They were not. `demo/m1-capture.ts:64` launches Playwright's bundled Chromium
with no `executablePath`, and nothing in `src/` or `demo/` reads `CHROME_BIN`.
The bench docker line mounted the patched build and exported `CHROME_BIN`
anyway. From the outside the run looked patched. It was not.

Fresh serial runs, same revision, same docker line, only the browser varying:

| Browser                  | capture efficiency | right-scroll captured / presented |
| ------------------------ | ------------------ | --------------------------------- |
| self-built, both patches | **98.2 %**         | **13 / 13**                       |
| self-built, unpatched    | 79.1 %             | 4 / 13                            |
| Playwright bundle        | 84.4 %             | 4 / 13                            |

> **Superseded:** the table of 21–39 % right-scroll capture, and the "18 %
> loss" it appeared to prove, describe the **unpatched** build. On the patched
> build that loss does not exist. Runs `verify-r2/art/vr1..vr3`, treated as
> the patched reference for three days, were unpatched — assigned by two
> independent fingerprints (capture gaps of 241–269 ms against 73–80 ms; 26–31
> duplicate frames against 137–167).

The process defect behind it is worse than the wasted effort: **no artifact
records which browser produced a run.** A set-but-ignored environment variable
is invisible. Reconstructing provenance afterwards took forensic
fingerprinting where one log line would have done. That is what #23 fixes.

---

## 2026-09-12 — what the finished video actually shows

Measured frame-to-frame displacement inside the right-scroll window, on the
assembled MP4s, in output pixels over 135 px of travel:

| Run                                                     | moving steps | largest step | repeated frames | largest / even step |
| ------------------------------------------------------- | ------------ | ------------ | --------------- | ------------------- |
| unpatched (today's product)                             | 1            | **111 px**   | 95 %            | **15.6×**           |
| both patches                                            | 12           | 30 px        | 55 %            | 4.9×                |
| both patches, vertical scroll (owner calls this smooth) | 37           | 32 px        | 35 %            | 4.1×                |

The teleport is gone. The patched horizontal scroll sits just below the
vertical scroll the owner accepts — which is exactly what the owner reported
after watching it: _clearly better, but still two hitches, in both
directions._

Note what this table does **not** say: 98.2 % capture efficiency and a visible
hitch are not in contradiction. They measure different things. Capture
efficiency asks what fraction of presented frames we received; it says nothing
about how evenly the surviving frames are spaced in the artifact the owner
watches.

---

## 2026-09-12 — the residual, and a live hypothesis (#25)

On the patched build the capture chain is no longer losing the right-scroll:
Chromium presents ~38 frames/s there and we receive 100 % of them, verified
against an independent all-process count. The residual roughness is upstream
of capture.

Two candidates, one of them ours:

- **Ours, and measured:** `paceWheel` (`src/record.ts:722-735`) paces wheel
  events against absolute 60 Hz deadlines but awaits Chromium's
  acknowledgement _inside_ the paced loop. The acknowledgement is tied to the
  next frame, so each step costs 16.5–17.8 ms against a 16.67 ms tick.
  Absolute deadlines mean the loop can never catch up, only fall further
  behind. Input drifts against the frame cadence, producing held frames
  followed by a catch-up step — the exact signature the instrument measures.
- **Not ours, and unproven:** Chromium's compositor discards a far higher
  share of frame updates during the right-scroll than the left-scroll, with
  the same asymmetry vertically (down worse than up). The suspicion is the
  DataGrid's horizontal column virtualisation — revealing new material costs,
  returning to already-painted material does not. **Read from behaviour, not
  proven at the main thread.**

> **Dead hypothesis, do not revive:** that our motion curve samples short
> moves too coarsely. Chromium coalesces wheel input per frame — 16 input
> steps in 270 ms yield 17 distinguishable frames, 48 steps yield 18, 96 steps
> yield 19. The ceiling is refresh rate × duration, not our step count. Six
> times finer input buys one frame.

The causal link between the pacing drift and the visible hitch is **inferred,
not proven.** It needs A/B runs, and the box went down mid-measurement with 8
of 12 runs unanalysed.

---

## 2026-09-12 — an instrument that looks at the artifact (#24)

Every number above except the pixel measurements is a counter _inside_ the
capture chain. None of them looks at the MP4 the owner judges. That gap is
what #24 closes: an instrument that measures motion smoothness on the finished
video.

Its design is shaped entirely by this project's own history of wrong
instruments:

- **Ground truth first.** Calibrated against 13 synthetic videos with known
  per-frame displacement, including the pathological cases — periodic content
  at the table's column pitch, sub-pixel motion, held frames, a single
  teleport, direction reversal, an independent side animation.
- **Two external bounds.** The sum of measured steps must hit the
  independently known travel distance; a window of duration _d_ cannot contain
  more than 60·_d_+1 frames, with _d_ supplied from outside. A window that
  breaks either bound reports **not measurable** and gives no smoothness
  verdict at all.
- **Refusal is a valid answer.** A run with no evaluable window says so
  explicitly, and says that this is not a clean bill of health.
- **Proven to move.** Deliberately corrupted real material — every third frame
  duplicated, every fourth deleted, frame pairs swapped — degrades the verdict
  in every case.

A naive estimator written during triage failed exactly as the history
predicts: it locked onto the DataGrid's column pitch and reported a constant
111 px displacement, and its step sum came to 24 px where 135 px was the
truth. The travel-distance bound catches precisely that.

On real material the instrument reports **2 hitches per right-scroll window**,
in both windows, plus one on the left-scroll, against **0** on the vertical
scroll of the same run. The owner, independently, said two hitches in both
directions.

**Not yet calibrated against the eye.** The hitch threshold is argued from
60 Hz physics and from the material, not fitted to the owner's judgement — no
such calibration series has ever existed in this project. It lives as one
named set of knobs, printable, not scattered through the code.

---

## Where the truth lives

| Question                                                          | Where                                        |
| ----------------------------------------------------------------- | -------------------------------------------- |
| Frame supply, the two Chromium patches, the owner's video verdict | #17                                          |
| Capture clock and the honest denominator                          | #21 (merged as #22)                          |
| Browser provenance, the `CHROME_BIN` trap                         | #23                                          |
| The smoothness instrument                                         | #24, [`SMOOTHNESS.md`](./SMOOTHNESS.md)      |
| Wheel pacing drift                                                | #25                                          |
| M1 acceptance                                                     | #2, [`M1-VERDICT.md`](./M1-VERDICT.md)       |
| One clock for capture and event log                               | #9                                           |
| Mechanisms, in detail and dated                                   | [`CAPTURE-CADENCE.md`](./CAPTURE-CADENCE.md) |

**Reading the older ticket comments:** percentages predating 2026-09-12 are
measured against the broken denominator, and the runs called "patched" before
#23 may not have been. Check which build a number came from before quoting it.

---

## The open decision

The proven fix for the frame supply requires shipping a **self-built, patched
Chromium**. That is a standing maintenance commitment — a rebuild per Chromium
roll, currently pinned at 153.0.8010.12 — and the upstream fix for the
underlying bug was reverted. The alternative is keeping a defect the owner has
already rejected on video. Recorded here as open; it belongs to the owner.
