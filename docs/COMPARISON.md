# Measured against three other tools

**When:** 2026-09-20 · **Where:** one machine, one container, one page.

The README used to say that nothing here had ever been measured against
another product. This is the measurement that removed that line.

Three open-source recorders were picked out of twenty by reading their source
for what they can do, not their README for what they say. All three ran
against featurecast's own bench corpus — the same page, the same machine, the
same container — and every output, including featurecast's own, was then read
with the same instruments.

|                                          | **featurecast**                      | **supercut**         | **cutroom**                      | **ultrademo**                                          |
| ---------------------------------------- | ------------------------------------ | -------------------- | -------------------------------- | ------------------------------------------------------ |
| Version measured                         | `a510b19`                            | `bd47f71`            | `d7172c3`                        | `e7bdcfc`                                              |
| Capture area                             | 2560×1600                            | 3840×2160            | 2560×1800                        | 1920×1080 (VP8, **25 fps**)                            |
| Delivered                                | **1920×1080 · 900×1600 · 1080×1080** | 1920×1080, fixed     | 1920×1080, fixed at capture time | 1920×1080 · 1080×1920                                  |
| Container frame rate                     | 60                                   | 60                   | 30                               | 30                                                     |
| **Frames that carry a new picture**      | **37.5 /s** (37.4 % repeats)         | **33.0 /s** (45.0 %) | **12.0 /s** (59.9 %)             | **18.2 /s** (39.4 %) · raw capture **1.0 /s** (96.1 %) |
| Portrait                                 | native crop                          | none                 | none                             | **upscaled 1.78×**                                     |
| Second look                              | **no browser at all**                | full Chromium        | a browser                        | a browser                                              |
| Second aspect ratio without re-recording | **yes, three**                       | no                   | no                               | yes, two                                               |
| Scroll a container, sideways             | **yes**                              | no                   | no                               | no                                                     |
| Bitrate delivered                        | 1.40 Mbit/s                          | 8.13 (configured 16) | 117.6 (ProRes)                   | 2.23                                                   |

## The three findings

**None of the three can drive the journey.** The bench corpus is a dense grid
that scrolls inside a container, sideways as well as down — the thing that is
actually hard to film. `supercut`'s scroll is a constant: 600 px down,
`deltaX` always 0 (`src/capture/executor.ts:446-463`), so sideways has no
expression at all. `cutroom`'s scroll helper drives the window rather than the
container (`capture/director.mjs:302-304`) and moved zero pixels on this page
without reporting an error — measured in the scene itself,
`before=[0,0,0] after=[0,0,0]`. `ultrademo` has no scroll command in its API
(`capture/capture.mjs:152-211`). Two of the journey's four moves exist only
here.

**A container frame rate is not a frame rate.** `supercut` writes 60 into the
container and moves 33 times a second. `cutroom` writes 30 and moves 12 —
that follows from its method, one screenshot per output frame with the clock
pinned, where every hold is literally the same picture N times. `ultrademo`'s
raw capture is 96 % still, because nothing can scroll and its cursor is drawn
at render time; its renderer recovers some of that with camera moves of its
own. featurecast leads at 37.5 of 60 — and that is also well short of its own
nominal rate. See #21.

**A second look is expensive everywhere else.** featurecast is the only one
whose re-render starts no browser at all: during the run not one Chrome
process existed in the container. `supercut` never revisits the application —
verified by re-rendering with the fixture server switched off — but its
renderer needs full Chromium, because the headless shell has no WebCodecs
(`src/render/host-page.ts:1-3`). `cutroom` writes its aspect ratio into
`timeline.json` at capture time, so a portrait version costs a new recording.
`ultrademo` delivers a portrait, but upscales it by 1.78×
(`render/src/Demo.tsx:422-424`); in a 1:1 crop of a text area the letter edges
are visibly soft, where featurecast's 900×1600 — deliberately smaller, never
upscaled — is sharp.

## Where this does not flatter us

- **featurecast's own effective cadence is 37.5 of 60.** It is the best number
  in the field, but the reason is not that it paints three times as many real
  frames: it is that its renderer keeps a camera moving. The repeated-frame
  problem in the capture itself is #21.
- **`supercut` captures at 3840×2160 and encodes at 8 Mbit/s**, against our
  2560×1600 and 1.4 Mbit/s. Our own README says 4K yes, 4K at 60 no. That is a
  real gap, not a framing problem — #67.
- **`cutroom`'s capture is the most deterministic of the four**: one screenshot
  per output frame with the clock pinned means two runs are identical by
  construction.

## What the numbers mean, and what they do not

The repeat share answers **"how many written frames are empty"**. It does not
answer "which tool is smoother": it counts a journey's deliberate pauses too,
and these four clips are 6.8 to 30.7 seconds long for the same actions, so
they carry different amounts of stillness in the denominator. A smoothness
verdict needs `tools/smoothness/`, which refuses to judge without a
recording's own motion windows — and only featurecast's runs have those. Rather
than apply a weaker instrument to the other three than to ourselves, the
smoothness row is absent.

The instrument itself is `tools/cadence/cadence.mjs`, calibrated against five
clips with a known answer in `tests/cadence.integration.test.ts`. ffmpeg's own
`framehash` and `mpdecimate` were built first and rejected; the reasons are in
`tools/cadence/README.md`.

**Single runs, no repeats.** Every number here is one run of one tool. The
ordering is large enough that a repeat is unlikely to reverse it, but that is
an expectation, not a measurement.

## Repeating it

Everything runs on a machine with a GPU, and foreign code runs only inside a
container.

```bash
git clone --depth 50 https://github.com/Co-Messi/supercut
git clone --depth 50 https://github.com/Ceasar369/cutroom
git clone --depth 50 https://github.com/new-xp/ultrademo
```

Serve `fixtures/bench/` over loopback — it is three files and works behind any
static server — and point each tool at it. Each tool's own journey file
(`bench.recipe.json`, `scenes/bench-tour.mjs`, `projects/bench-tour/flow.mjs`)
expresses as much of featurecast's `demo/fixture-tour.ts` as that tool can.
Where a move has no expression, that absence is the result; it is not
substituted.

featurecast's own arm, recorded in the same container immediately before:

```bash
pnpm featurecast run demo/fixture-tour.ts --devices desktop
pnpm render artifacts/fixture-tour/desktop dist/tour --all-formats
```

Then, on every output file the same way:

```bash
node tools/cadence/cadence.mjs <video.mp4>
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,avg_frame_rate,bit_rate \
  -of default=noprint_wrappers=1 <video.mp4>
```
