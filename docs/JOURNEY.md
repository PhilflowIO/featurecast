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

The owner watched `artifacts/m1-008/output.mp4`, recorded from the real UI
of the recorded application on the RTX 3090 box. Verdict: **vertical scrolling is smooth,
horizontal scrolling visibly hitches, reproducibly.** That is the acceptance
criterion of ticket 2, and it failed. Full reasoning in
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

Two mechanisms were found and are real (detail in ticket 17):

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
requirement on every instrument this project builds (ticket 24).

> **Superseded:** earlier comments on ticket 17 and ticket 21 quote **86.7 %** for the
> right-scroll. That figure comes from the broken `paint-rate` denominator.
> Percentages measured against the old denominator are comparable _among
> themselves_ — the Playwright ↔ unpatched ↔ patched comparison used one
> consistent yardstick and still holds — but they are not valid as absolute
> levels.

---

## 2026-09-12 — the capture clock (ticket 21, merged as ticket 22)

Screencast frame timestamps sometimes step backwards. The assembler clamped a
backwards timestamp forward onto its predecessor, which produced 37–42
zero-length gaps per run. ffmpeg resolves two frames sharing one output slot
by keeping the _later_ one — so those clamped frames were deleted from the
video after having been captured successfully. Proven with a barcode probe
through the real production chain.

Fixed by sorting on capture order instead of clamping; confirmed at the pixel
level (12:0 in favour of capture-order sorting).

Still open on ticket 21, deliberately: **re-basing the timeline onto Chromium's real
presentation times is rejected but _unproven_**. The counter-experiment that
rejected it had a bug of its own and lost 40 frames before the encoder ran.
The lever is open; it was simply not the question at hand.

---

## 2026-09-12 — the correction that invalidated three days of numbers (ticket 23)

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
fingerprinting where one log line would have done. That is what ticket 23 fixes.

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

## 2026-09-12 — the residual, and a live hypothesis (ticket 25)

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

## 2026-09-12 — an instrument that looks at the artifact (ticket 24)

Every number above except the pixel measurements is a counter _inside_ the
capture chain. None of them looks at the MP4 the owner judges. That gap is
what ticket 24 closes: an instrument that measures motion smoothness on the finished
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

## 2026-09-13 — the instrument ranked the arms backwards (ticket 28, ticket 29)

The first run of the instrument across all three browser arms exposed two
defects in its _summary_, not in its measurement:

- **Sort windows got a hitch.** The table re-renders, nothing slides, and the
  travel-distance bound had no expected value. "Not checked" was treated as
  "passed" and a direction was inferred from exactly 0 px. Now an unchecked
  bound withholds the verdict just as a broken one does (ticket 28). On real runs
  that leaves 10 of 38 windows judged — the report now says so up front.
- **The hitch count ordered the arms the wrong way round.** The stock browser
  teleports the whole horizontal travel in one frame and got _one_ hitch; the
  patched build got _two_. The count records that something happened, never
  how bad (ticket 29). Verdicts now carry the largest step in _even steps_ (expected
  travel ÷ frame pairs, both from `motion-windows.json`), and a frame that
  delivers half the travel is called a teleport.

Measured on the three real runs, over the 10 windows judged in all of them:

| Browser                  | largest step, even steps | teleports | hitch count |
| ------------------------ | ------------------------ | --------- | ----------- |
| self-built, both patches | **4.7**                  | 0         | 13          |
| self-built, unpatched    | 15.6                     | 2         | 15          |
| Playwright bundle        | 17.1                     | 2         | 14          |

That is the owner's order. The count alone would have put the stock browser
ahead of the unpatched build. The stock-behind-unpatched margin rests on one
window (128 px against 111 px); patched against unpatched is wide. The
ordering is pinned by `tools/smoothness/tests/test_browser_arme.py` on
fixtures extracted from the real runs.

Also found on the way: the jump factor divided by 10⁻⁶ when the neighbouring
frames stood still and reported catch-ups at 110 million times the local
speed; and the instrument held a whole run in memory (over 9 GB), so the arms
could not be re-measured on the workstation at all. Both fixed. The re-measured
frame pairs match the earlier measurement exactly, 12,359 of 12,359.

Still open: the threshold itself is not calibrated against the eye (ticket 30), and
`invoices:scroll-up` misses its travel bound by the same ~20 % in all six
instances — systematic, unexplained (ticket 31).

---

## 2026-09-14 — the provenance record that recorded nothing (ticket 23, ticket 36)

ticket 23's fix was merged two days ago and had never launched a browser: the box
was unreachable and the CI runner takes no jobs. Run on the box, the
mechanism holds. Playwright's Chromium is a **direct child** of the node
process in the measurement container, so `/proc/<pid>/exe` identifies it and
`listChildExecutables` needs no widening — the descendants (zygote, GPU,
renderers) share the parent's binary and collapse into the same single entry.
Both `--version` lines are usable: `Google Chrome for Testing 153.0.8010.12`
for the bundle, `Chromium 153.0.8010.12` for a self-built tree.

Three refusals, each with its own message, all reproduced in the container:
`CHROME_BIN=/does/not/exist` stops before launch; an empty `CHROME_BIN` stops
with the "set but empty" message rather than falling back; and a wrapper
script that execs a different binary is caught after launch — `Requested
browser /fake-chrome (CHROME_BIN) but the running browser is
/ms-playwright/.../chrome-headless-shell`. That last one is the ticket 23 incident
itself, provoked on purpose.

Nine runs through the product entry point, three arms interleaved per
repetition against the live app:

| Arm                      | capture efficiency (3 runs) |
| ------------------------ | --------------------------- |
| self-built, both patches | 97.2 / 97.6 / 97.8 %        |
| Playwright bundle        | 83.5 / 84.6 / 83.0 %        |
| self-built, unpatched    | 81.3 / 81.4 / 81.2 %        |

The ordering matches the 2026-09-12 table; the spread narrowed (the earlier
98.2 / 84.4 / 79.1 came from single runs).

**And the acceptance found what the fix still missed.** Both self-built arms
mount their build at `/crbuild/chrome` and both report `Chromium
153.0.8010.12`, so path plus version — everything ticket 23 asked for — named the
patched and the unpatched browser identically, while their capture efficiency
differed by 16 points. A provenance record that cannot separate the two arms
of the experiment it exists for is not a record. `browser.json` now carries a
SHA-256 over the running binary's bytes (ticket 36); the two arms come out as
`ed29ff73…` and `fdb37b22…`, matching the host's own `sha256sum`.

Also standing: `demo/m1-capture.ts` ends in a hard error on the bundle and on
the unpatched build, because capture efficiency below 95 % is a failure by
design. That is the floor doing its job, not a broken run.

The full Vitest suite ran on the box for the first time since ticket 34/ticket 35: 23
files, 205 tests, green — including the five browser-driving suites. A second
run of the same suite was red in exactly one case, and re-running that file
alternates pass and fail: the scroll-rate floor of 50 distinct positions per
second sits inside the measurement's own spread (47.3-50+), so it says nothing
either way (ticket 38).

---

## 2026-09-14 — the pacing fix held its tick and made the hitch worse (ticket 25, ticket 40, ticket 42)

The input pacing from ticket 35 does what it claims: the same scroll travel now
takes 20 frame pairs instead of 23. What it does not do is remove the
hitch.

Getting to that answer took two corrections first. The motion window ended
when the last wheel event was acknowledged, which was fine while the input
throttled itself against Chromium's acknowledgements and wrong the moment
it stopped: the window closed mid-motion, the horizontal scrolls measured
131-169 px of 172.5 px inside their own window, and the instrument
withheld its verdict on exactly the windows the question was about. The
travel was never lost — the same runs show the full 171.8 px when the
instrument decomposes the motion itself. A scroll now returns when the page
has stopped moving, observed by listening for `scroll` events rather than
polling offsets, because polling is main-thread work during the capture
being measured (ticket 40).

The second correction is a lesson about this suite. That fix shipped with
two test files run, not the suite; `tests/tsx-pipeline.test.ts` exists
precisely because Vitest transforms without `keepNames` while `tsx` does
not, and a named function inside a `page.evaluate` payload therefore dies
in production and nowhere else. Every real run crashed on
`ReferenceError: __name is not defined` while the browser suites stayed
green (ticket 42). **For `src/record.ts`, the whole suite on the box is the gate,
not a selection.**

With both arms carrying the window fix, three interleaved repetitions each:

| Arm              | hitches per window | worst jump, median | worst jump, max |
| ---------------- | ------------------ | ------------------ | --------------- |
| before ticket 35 | mostly 2           | 4.70 even steps    | 5.70            |
| after ticket 35  | mostly 1           | **6.60**           | **12.10**       |

Fewer disturbances, much heavier ones. Measured independently of the
instrument (phase correlation straight off the video), the after-arm puts
46 px in a single frame pair against neighbours of 12-16 px, in both
directions; the before-arm's worst is 31 px and only at the start. The
owner watched both recordings at normal speed and ruled: "A only judders once
at the start, otherwise A is much better. B judders right back as well." So
ticket 35's pacing gets reverted and the window fix stays.

Two things worth keeping from this. The hitch **count** favoured the arm
the eye rejected; only severity got it right, which is the ticket 28/ticket 29
decision confirmed on real material. And "judders right back" is not backwards
motion — there is no step against the direction of travel in either arm.
It is one jump big enough to read as a teleport, which is the first
calibration bracket the eye has ever given this project (ticket 30): ~5 even
steps is tolerated, ~12 is unusable.

The cause of the hitch is therefore still open, and the compositor
suspicion above is what is left.

---

## 2026-09-14, night — the revert, measured (ticket 45, ticket 25)

The owner's verdict was a verdict on a video. Reverting on that alone
would have left the project with a decision it could not defend six
months later, so the revert was measured the same way the change had
been: three interleaved repetitions per arm on the patched build against
the same live application, alternating so the application's own drift
hits both arms equally.

| Arm                            | worst jump, median | worst jump, max | hitch events |
| ------------------------------ | ------------------ | --------------- | ------------ |
| revert (new)                   | **3.59**           | **5.94**        | 61           |
| after ticket 35 (new, control) | 6.61               | 13.80           | 105          |
| before ticket 35 (2026-09-14)  | 4.54               | 5.66            | 57           |
| after ticket 35 (2026-09-14)   | 6.58               | 12.08           | 94           |

The revert lands in the band of the old before-ticket 35 arm. What makes the
two campaigns comparable at all is the **control arm carried along**:
re-running the after-ticket 35 build today reproduces its own earlier numbers.
Without it, every difference could equally have been a change in the
application.

The distributions tell the story better than the medians. The revert arm
has not one window above 6 even steps; the paced arm has ten of twelve
there and one at 13.8. That is exactly the shape the eye described:
"only jerky once at the start, otherwise much better."

**The measurement definition is written down because it had to be
re-derived.** The numbers here come from
`schwere.groesster_sprung_gleichschritte` over every window with
`achse == "x"` and measured translation, median and max over the twelve
windows of an arm, all four arms through one script on one instrument
build. That yields 4.54/5.66 and 6.58/12.08 for the older arms where the
earlier comment reported 4.70/5.70 and 6.60/12.10 — same magnitude, same
conclusion, slightly different selection or rounding. Four numbers from
one script are comparable; holding them against the older pair compares
two definitions.

### What the revert broke, and why that was the interesting part

The first full run on the box was red at exactly one place, and not at
the reverted code: the **outer anchor** of the scroll-rest test. That
anchor exists to prove the fixture has a motion tail at all — without it
the real assertion would pass for free on a page that stops the instant
input does. It was itself a function of input pacing. The fixture summed
`deltaY` into its glide velocity, and a minimum-jerk scroll ends in
sub-pixel steps: without waiting for acknowledgement enough velocity
survived for a long glide; with waiting, the decay eats the last steps
and the tail collapses to one frame. Measured: 16.7 ms against a bound
of 30.

An anchor that only holds under one pacing strategy anchors nothing. The
fixture now re-arms the same glide at a fixed 25 px per frame on every
wheel event, whatever its delta, so the tail is ~330 ms however the
wheels arrived. The protected assertion and its bound are unchanged.

This is the third time in this project that a green suite was hiding
behind a measurement device that could not move (ticket 38, ticket 42, and now this)
— and the second time the **full** suite on the box was what caught it.

### The honest gap

A mutation probe shows that **no test in the suite dies** if the
deadline in the wheel pacing is removed outright. The behaviour restored
here is not test-covered — it was not covered before ticket 35 either. The
evidence that it is better comes from the measurement, not from the
suite.

---

## 2026-09-14, night — a target distance that was never the target (ticket 31, ticket 47)

`invoices:scroll-up` had been failing its distance bound in all six
measured cases, always by the same ~20 %, while its sibling scroll-down
held to 1 %. The suspicion was that ticket 40 — the motion window that ended
with the input rather than with the motion — explained it too.

It does not, and the fixtures were enough to prove that without a
browser: after the up-window, 0.7 px of motion remain. There is no
truncated tail for ticket 40's fix to recover; the upward motion really is
shorter.

The defect was in the expectation, not the measurement. The recording
script knows the distance it actually asked for, and knows the scroll
position before and after — and wrote neither. It wrote the container's
full scroll range, which equals the travel only as long as the motion
runs edge to edge. Only the upward motion depends on a starting position
some other step left behind: in `invoices` the container sits ~85 px
short of its range when the up-window starts, in `tasks` 2 px, which is
why `tasks` held.

Windows now carry the travelled distance plus the scroll position before
and after, so a future shortfall is a number in the file instead of a
feeling. **The 10 % bound was not touched**, and runs without the new
field — including the checked-in browser-arm fixtures — still fall back
to the old number and say so in their provenance.

The residual 85 px is a finding of its own (ticket 47): the recording does not
return to its starting state, so repetition 2 begins somewhere
repetition 1 did not. For a tool whose core promise is repeatability
that is a precondition, not a footnote.

---

## 2026-09-14, night — three milestones' worth of surface, and what a reviewer found

M5 (device layer), the first half of M6 (Garage upload, NVENC path) and
M7 (recipes for turning an existing Playwright script into a recording)
landed the same night, each built in its own worktree and each reviewed
by a read-only verifier before merge. Two things are worth keeping.

**A self-signed request needs a foreign witness.** The upload signs
AWS SigV4 itself rather than taking on a three-digit dependency count
for one PUT. A test that freezes the implementation's own output proves
nothing, so the signature is anchored against botocore with a frozen
clock — and the reviewer did not take that on trust either, but ran
botocore again independently and got the same signature byte for byte.

**The reviewer's most useful findings were assertions that could not
fail.** The device layer handed out Playwright's registry object by
reference — and a test insisted on object identity, so the fix was
blocked by its own suite until the assertion was turned around. Another
test checked only the headline of an error message, never that the list
of suggested names was actually narrowed (78 of 207 in practice);
replacing the narrowing with the full list left the suite green. Neither
was a bug a user would have hit tomorrow. Both were places where the
suite said "yes" without being asked anything.

Everything here is library surface with the acceptance criteria still
open: no device has driven a real recording, no upload has reached a
real Garage, no NVENC encode has run. What is proven is the argument
list and the signature; what is assumed is that the far side accepts
them.

---

## 2026-09-14, night — we were not scrolling the container we meant (ticket 47, ticket 31)

`invoices:scroll-up` had been failing its distance bound by ~20 % in
every measured case. The window now carried the scroll offsets before and
after, so a fresh run on the box could simply be read: the upward motion
starts at 454 and stops at **91**, having been told to travel 454. And
`tasks:scroll-up` stops at 3 instead of 0 — every upward motion falls
short, `invoices` worst.

Then the question worth asking: where did the missing pixels go? A probe
dumped **every** scrollable element of the page after each window. After
`invoices:scroll-up` the outer container sits at 91 and everything else
— the grid's own virtual scroller, the navigation, the document — sits
at 0. The pixels are not somewhere else. They never arrived.

What gave it away was that the grid's inner scroller moves from 2 to 0 in
exactly the affected windows: it takes part in the motion without
absorbing it. The wheel was being delivered to the **centre** of the
target's rectangle, and on that view the centre sits over the grid. One
changed line — wheel 20 px inside the top-left corner instead — and every
window hits exactly: 456 → 0, 590 → 0, 188 → 0, both repetitions.

Chromium latches a wheel gesture to the element under the cursor. An
inner scroller with 2 px of room catches the gesture and does not hand
the remainder on. That is also why only the upward direction suffered:
going down, the inner scroller is already at its end and passes
everything through immediately.

The fix is not "20 px from the corner" — that was the probe. Candidate
wheel points are now spread over the target's **visible** area, hit-tested
in the browser, and the first one that reaches the target with no other
scrollable element in between wins. If none is free the run stops; there
is no fall-back to the centre, because falling back to the broken point
is the defect itself.

**What this says about ticket 31.** Repairing the reported distance would not
have been enough. The motion really was short. With the wheel delivered
correctly, the distance bound holds in every window — `invoices:scroll-up`
at 0.2 % deviation — and not a single tolerance was touched.

Three days of "the instrument is too strict" were, in the end, the
instrument being right.

---

## 2026-09-15 — M4 landed, and the first real video failed on pacing (ticket 5, ticket 60, ticket 64)

The post-processing work — zoom onto the element that was hit, the pointer
drawn from the event log, idle trimming, three formats from one recording —
had been sitting finished on a branch since 12 September with no pull
request. Landing it took two rounds and three read-only verifiers, and the
verifiers were the point.

**All three returned `fail`, and the most expensive finding was about the
fixtures, not the code.** Two of the twelve recordings the zoom tests ran
against had been written by hand while a comment claimed they came from a
real recording: they started the pointer at (640,360) instead of the origin
the recorder always enforces, and padded stillness with bit-identical
samples the motion generator would never emit. The assertion meant to catch
exactly that existed only as a sentence in a comment — and would have been
blind anyway, since padded samples have step size zero. Two more fixtures
were byte-identical twins of each other. Seventeen numeric claims in the
comments were recomputed and six were wrong, including a bound described as
having 15 % headroom that actually holds by four hundredths of a percent.

**A mutation round of 68 edits left 23 alive.** The pull-out guard the round
before had been built to fix turned out to be unreachable: nothing in the
suite ever pushed it past its limit, so all of that work was unproven.
The drawn pointer was completely unmeasured — freezing its position,
shrinking it from 46 px to 4 px, or pinning the device pixel ratio all left
the suite green, because no test imported any of the cursor functions. One
mutation did not fail but hung: removing the no-upscale floor sends the
suite into an infinite loop, which this suite can only reveal as a CI
timeout.

Both rounds landed as ticket 60, the chain work as ticket 64. Then the chain produced a
real video for the first time: 20.7 s of recording, 117 source frames, three
formats in 16.6 s from one render call, deterministic to the byte, a look
change costing 9.1 s instead of a second browser run. The portrait format
came out 900×1600 instead of 1080×1920 — deliberately, because upscaling is
not sharpness, and sharp portrait is M3.

**What the real run revealed that no test could: the camera has no room.**
A 2560×1600 capture delivered at 1920×1080 is already 1.33×, and that is the
entire zoom budget. The 32×32 dark-mode button asked for 4.62× and got 1.33×.
That is not a bug in the zoom; it is the arithmetic of over-capturing. The
owner chose to capture larger (3840×2400) rather than deliver smaller (ticket 67).

---

## 2026-09-15 — the pointer moved like a slideshow, and the camera was innocent (ticket 9, ticket 66)

The owner watched the video and rejected it: the pointer motion reads as a
slideshow. The diagnosis was run as an experiment, not as reading. Three
renders of the same raw material, measuring the largest pointer step per
output frame:

| Variant                            | Largest step |
| ---------------------------------- | ------------ |
| as delivered                       | 66 px        |
| camera held still (`--zoom 1.001`) | 65 px        |
| idle trimming off                  | **15 px**    |

Holding the camera still changes nothing. The recorder guarantees at most
20 px between two samples and proves it by construction, so the motion
itself was never the problem. **Idle trimming was.** Its signal is whether
the captured _picture_ changed — and a page at rest with a pointer moving
across it looks exactly like stillness. A 700 ms journey gets compressed to
250 ms, the same distance lands on a third of the frames, and the pointer
jumps.

The first diagnosis was wrong and had to be withdrawn mid-run: measured in
_output_ coordinates the pointer moves 66 px, which blames the camera,
because the camera moves too. In source pixels it moves at most 16 px. The
instrument that followed therefore measures source pixels, and it carries
two denominator guards — frame count and trimmed milliseconds — so it cannot
go green by having nothing to measure. A synthetic reconstruction failed to
reproduce the defect for exactly that reason: marking one frame per
interaction puts every gap's end on an interaction, where the protection
window shields it, so nothing was trimmed and the bound passed vacuously.
The fixture is the real recording the owner watched (ticket 66, deliberately red
at 86.3 px against 20).

**Underneath sits a second defect, and it dictates the order of the fix.**
The trimmed stretches are wall-clock frame times; the events carry counted
60 Hz slots. In this recording the log claims 14.7 s for a capture that took
20.7 s. A protection window built from slot counts guards the wrong second —
which `plan.ts` already said about itself, with the caveat that no harm had
been reproduced. It has been reproduced now. So the order reverses: one
clock first (ticket 9), then teach trimming that a stretch is only still when the
page _and_ the pointer are still.

---

## Where the truth lives

| Question                                                          | Where                                              |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| Frame supply, the two Chromium patches, the owner's video verdict | ticket 17                                          |
| Capture clock and the honest denominator                          | ticket 21 (merged as ticket 22)                    |
| Browser provenance, the `CHROME_BIN` trap                         | ticket 23, ticket 36                               |
| The smoothness instrument                                         | ticket 24, [`SMOOTHNESS.md`](./SMOOTHNESS.md)      |
| Instrument verdict: unchecked bounds, severity                    | ticket 28, ticket 29                               |
| Eye calibration of the hitch threshold                            | ticket 30                                          |
| Wheel pacing drift, why it was reverted, and the proof            | ticket 25, ticket 45                               |
| Motion windows that report travel instead of range                | ticket 31, ticket 47                               |
| Device layer, upload, recipes                                     | ticket 6, ticket 7, ticket 8                       |
| Motion windows that end with the motion                           | ticket 40                                          |
| M1 acceptance                                                     | ticket 2, [`M1-VERDICT.md`](./M1-VERDICT.md)       |
| One clock for capture and event log                               | ticket 9                                           |
| M4 acceptance: what the chain produced, and what is unproven      | ticket 5, [`M4-ACCEPTANCE.md`](./M4-ACCEPTANCE.md) |
| Pointer pacing, the slideshow verdict, the instrument             | ticket 66                                          |
| Unreached bounds found by the mutation round                      | ticket 62                                          |
| Capturing larger, and what breaks below 2560x1600                 | ticket 67, ticket 63                               |
| Mechanisms, in detail and dated                                   | [`CAPTURE-CADENCE.md`](./CAPTURE-CADENCE.md)       |

**Reading the older ticket comments:** percentages predating 2026-09-12 are
measured against the broken denominator, and the runs called "patched" before
ticket 23 may not have been. Check which build a number came from before quoting it.

---

## The open decision

The proven fix for the frame supply requires shipping a **self-built, patched
Chromium**. That is a standing maintenance commitment — a rebuild per Chromium
roll, currently pinned at 153.0.8010.12 — and the upstream fix for the
underlying bug was reverted. The alternative is keeping a defect the owner has
already rejected on video. Recorded here as open; it belongs to the owner.
