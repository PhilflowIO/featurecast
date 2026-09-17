# Motion smoothness on the finished video

Measured and built 2026-09-12. Tool: `tools/smoothness/`.

**A note on the labels.** The tool itself speaks German — its output, its
command-line switches and its JSON keys use `Haker`, `Störstelle`,
`Nachholsprung`, `NICHT MESSBAR`, `--lauf`, `haelt`. Those are quoted here
exactly as the tool prints them and are not translated, because a second set
of names for the same thing would drift apart from the first within a week.
The prose around them is English: a hitch is a `Haker`, a disturbance is a
`Störstelle`, a catch-up jump is a `Nachholsprung`, and `NICHT MESSBAR` means
not measurable.

## Why this tool exists

Every number this project has reported so far is a counter **inside** the
capture chain: `src/efficiency.ts` counts how much of what Chromium put on the
screen actually arrived; `src/presented.ts` supplies the denominator for it;
`src/cadence.ts` measures the delivery spacing of the source. None of them
ever looks at the finished MP4.

The owner looks at exactly that, and his verdict on the `compare3` run (patched
Chromium, both fixes, 98.2 % capture efficiency) was: _clearly better, but not
free of judder — two hitches, in both directions._ 98.2 % and a visible hitch
are not in contradiction. They measure different things. This tool measures
the artifact.

## What is measured

The displacement from frame to frame, in pixels, for every pair of consecutive
output frames — and from that, per motion window, how evenly those
displacements are distributed.

The displacement is determined by **phase correlation over FFT**, which only
lets a value stand if its correlation peak is clearly better than its best
secondary maximum. As a second, differently built opinion, **block-wise
Lucas-Kanade flow** runs alongside. If the two disagree, a third test decides
directly on the image: whether shifting back by the claimed displacement
halves the residual difference in the places where anything changed at all.

**Why not simpler.** During triage an estimator was written on the
"smallest mean difference" principle. It locked onto the table's column pitch
and reported a constant 111 px for frames that had barely moved — confidently,
without doubt. On vertical motion it is blind, because it only searches over
horizontal displacements, and it declares that assumption nowhere. Both faults
are pinned in `tests/test_naiver_schaetzer.py`, so the reason for the effort is
not lost.

**Why not ffmpeg's own facilities.** `scdet` finds scene changes cleanly,
`signalstats.YDIF` counts repeated frames well (18 found against 19 true,
denominator 60 frames), `freezedetect` and `mpdecimate` deliver only yes/no per
frame. None of them outputs a displacement in pixels, so none of them can say
_how_ smooth a movement is. The codec's motion vectors are not numerically
readable through `ffprobe` — `side_data_list` contains only the entry
`{"side_data_type": "Motion vectors"}` with no values — and they are an
encoder's decision anyway, not a truth about motion.

## The definition of a hitch

> A **hitch** (`Haker`) is a place within the travel of a uni-directional
> movement where the frame-to-frame displacement departs from the pace of its
> immediate neighbours: either **at least two consecutive frames below 25 % of
> the local pace** (a stall of ≥ 33 ms), or **a single step above twice the
> local pace** (a catch-up jump). Events less than four frames apart are
> **one** disturbance — the eye cannot separate two stumbles 50 ms apart. What
> is counted is disturbances.

## Severity: how bad, not only how often

The number of hitches on its own ranks wrongly (ticket 29). On real material
the stock browser, which skips the whole sideways travel in one frame, got
**one** hitch; the patched build with two small catch-ups got **two**. The
count says that something happened, never how bad it was.

Every verdict therefore names the **largest step in even steps**. An even step
is the target distance divided by the window's frame pairs — the step a
perfectly uniform movement would take per frame. Both quantities come from
`motion-windows.json`, not from the measurement. A jump of 15 even steps means
that the travel of 15 frames arrives in one. Every disturbance additionally
carries its largest step in pixels and its stalled time in milliseconds.

If a single frame pair delivers **at least half the target distance**
(`teleport_anteil`), the verdict is called **teleport**: between the jumps the
movement does not exist. Disclosure: this value was introduced after looking
at the three browser arms (unpatched 82–95 %, patched 20 %) and sits
deliberately far between the two.

The jump factor against the local pace exists only where there is a local
pace. When the neighbours stand still (below `still_px`), the first version
divided by 10⁻⁶ and reported catch-up jumps at 110 million times the pace.
There is no factor there now, but the step in pixels.

**Comparing runs.** `smoothness --vergleiche a.json b.json c.json` orders
reports from the same recording script from smooth to hitchy, by the largest
step in even steps. The comparison runs only over windows that were judged in
**every** run, and their number is printed in the output — otherwise the run
whose worst window happened to be refused wins.

## The knobs and their justification

All of them live in `tools/smoothness/smoothness/knobs.py`, each exactly once,
and `smoothness --erklaere-schwelle` prints them with their justification. The
four that carry the definition above:

| Knob               | Value | Why this value                                                                                                                                                                                                                                                     |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stall_frac`       | 0.25  | The comparison is against the **local** pace, not against the window median. The product scrolls with an acceleration and braking curve; a fixed yardstick counted every acceleration as a jump — first version: 33 hitches in a 47-frame window.                  |
| `stall_min_frames` | 2     | Two frames are 33 ms, the usual visibility threshold for dropouts at 60 Hz. Single-frame dropouts are not concealed but reported separately as _micro-dropouts_ with a denominator of their own.                                                                   |
| `jump_factor`      | 2.0   | The point at which one frame skips more than the travel of two frames — so at least one frame is missing.                                                                                                                                                          |
| `merge_gap`        | 4     | The fusion threshold of perception. **Disclosure about the order of events:** this value was introduced _after_ the first run on real material, because five or six separate events occurred there within 0.3 s. It is justified by perception, not by the result. |

## The two external bounds

Both are criteria that do **not** come from the calculation they check. A
window that breaks either of them **or cannot check it** gets **no** smoothness
verdict, but `NICHT MESSBAR` with a reason.

The second half of that sentence was added on 2026-09-12 (ticket 28): the
first version withheld the verdict only for a _broken_ bound. Sort windows, in
which the table merely re-renders, have no target distance — and got a hitch
anyway, along with a direction "derived" from a measurement of exactly 0 px.
As a result the tool's own segmentation (without `--lauf`) now delivers
measurements only, no verdict: it has no target distance.

**Travel-distance check.** The sum of the measured individual displacements
must hit the independently known travel distance (tolerance 10 %). The target
distance is in the `target` field of `motion-windows.json`
(`src/m1-benchmark.ts` writes the element's scroll distance there) and is
converted into crop pixels using the scale. The failed estimator would have
delivered 24 px instead of 135 px here and would have been rejected.

**60 Hz bound.** A window that lasts _d_ seconds according to an independent
source can contain at most 60·_d_+1 frames.

## What was twice wrong about this bound

These two paragraphs stay, because the same mistake has now occurred four
times in this project and looked plausible every time.

**First mistake (prototype, fixed before it moved into the repository).** The
first version computed the window duration from its own frame count. `n`
frames give `n/60` seconds give an upper bound of `n` frames — so the bound
could **never** fire. The same circular argument as in `src/paint-rate.ts` and
in the first version of `src/presented.ts`. Fixed by making the duration a type
of its own that carries its provenance (`bounds.Dauer`); a duration derived
from the tool's own frame count is explicitly rejected.

**Second mistake (found on the way into the repository, 2026-09-12).** That was
not the end of it. As soon as the window boundaries are derived from the same
duration — and that is exactly what `windows.aus_lauf` does, by converting
video time into output frames — the number of **output frames** in the window is
by construction at most 60·_d_+1 again. The circular argument had come back one
level up. What is counted now is therefore the **capture frames** from
`timestamps.json`: they come from a different measurement than the window
boundaries and can very well be too many. If no such independent number exists,
the bound reports `haelt: null` with the reason "tautological" — not "passed".

## Refusing rather than grading

Three outcomes have to be distinguished, and the tool distinguishes them:
checked and passed, checked and broken, **not checked at all**. The third is
not a pass. A run in which no window was evaluable says so literally: "KEIN
auswertbares Bewegungsfenster gefunden — das ist KEIN gutes Zeugnis, sondern
eine Verweigerung" ("no evaluable motion window found — that is not a clean
bill of health but a refusal"), and reports the jitter measure alongside it
(how often the movement changes direction).

Every report begins with a **summary**: how many of the run's windows were
judged and how many were withheld, with a reason per window
(`strecke_ungeprueft`, `strecke_verfehlt`, `60hz_ungeprueft`, `60hz_verletzt`,
`zu_wenig_gueltig`). A hitch total without that denominator would read like a
verdict on the whole run, when on real material it covers only 10 of 38
windows.

Left and right are reported separately and never averaged. The owner reports
hitches in both directions; an average would have cancelled them against each
other.

## Limits

What this tool **cannot** do and what about it is **not** proven. The list is
the honest part of the measurement and is not shortened.

- **No colour.** Everything is measured on greyscale. A movement that shows up
  only in the colour channel is invisible to the tool.
- **Translation only.** What is proven are translations. Rotation, scaling
  (zoom), cross-fades and opacity animations are not modelled. Calibration case
  c8 shows only that a _local_ side animation (a rotating icon, a tooltip
  fading in) does not interfere.
- **One moving object only.** If two areas scroll at different speeds at the
  same time, the tool measures the majority displacement. That case is not
  proven.
- **The threshold is not calibrated against the eye.** A calibration series of
  the form "from here on the owner calls it hitchy" has never existed in this
  project. The values are argued from 60 Hz physics and from the material. What
  is pinned against the eye so far is only the **ordering** of the three browser
  arms (`tests/test_browser_arme.py`), no threshold. The calibration series is
  outstanding in ticket 30 and needs a reachable capture machine.
- **Stock behind unpatched rests on a single window.** Both unpatched arms
  teleport; that the stock browser counts as the worse of the two, as the owner
  says, rests entirely on `tasks:scroll-right:2` (128 against 111 px). The
  separation between patched and unpatched is wide (4.7 against 15.6 even
  steps).
- **The method's limit is the aliasing case.** With exactly periodic content
  and a large displacement per frame, two different displacements are the same
  image information (at a raster period of 111 px: +70 and −41). From two
  frames that is in principle undecidable. The tool refuses the majority of
  frame pairs there and gets a remainder wrong; only the travel-distance bound
  catches that. Calibration case `c12`, pinned in `tests/test_eichung.py`.
- **Quarter-speed videos are no good.** In the slow-motion files of the
  comparison run, 61–71 % of the frames are repetitions of the slow motion
  itself. Measured, not assumed.
- **Real run data: three runs, one per browser.** Since 2026-09-13
  `tests/test_browser_arme.py` checks against the frame pairs and run files of
  three real recordings (provenance and checksums in `tests/browser_arme/`).
  The travel-distance check holds there on the `tasks` scrolls and on
  `invoices:scroll-down`; **`invoices:scroll-up` breaks it in all six instances
  with the same deviation** of around 20 %. That is systematic, not noise, and
  unexplained (ticket 31). Repeatability across several runs of the _same_
  browser has not been shown.
- **Run time.** A whole run (around 4300 frames at 1920×1080) takes 130 to
  180 s and under 300 MB of memory. It is untested for CI; the Python tests do
  not run in this repository's CI at all at present (ticket 32).

## What the prototype measured on real material

These numbers come from the preliminary work
(`.claude/handoffs/messtechnik-glaette.md`, 2026-09-12) and are **not**
reproduced here — the comparison video is not in the repository. They are here
because they answer the owner's question, and they count as unproven until a
run repeats them.

| Run                            | frame pairs | median step | largest single jump | repeated frames | verdict       |
| ------------------------------ | ----------- | ----------- | ------------------- | --------------- | ------------- |
| panel 1, stock browser         | 8           | 1.70 px     | **55.49 px**        | 3/8 = 37.5 %    | 1 disturbance |
| panel 2, self-built, unpatched | 8           | 1.70 px     | **55.51 px**        | 3/8 = 37.5 %    | 1 disturbance |
| panel 3, patched               | 17          | 3.68 px     | 13.87 px            | 3/17 = 17.6 %   | **2 hitches** |
| panel 3, patched (2nd window)  | 20          | 2.27 px     | 13.87 px            | 4/20 = 20.0 %   | **2 hitches** |

The stock browser does not scroll, it jumps: 55.5 of 67.4 px total travel, so
82 %, happen in a single frame. The patched build spreads the same travel over
17 to 20 frames. That is the gain from the patches, measured on the artifact
for the first time — and the two remaining disturbances are, in order of
magnitude, what the owner saw.
