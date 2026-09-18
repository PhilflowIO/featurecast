# Devices

A device is a name in the invocation. Everything else — window size, pixel
ratio, touch instead of mouse, aspect ratio of the video, pointer rendering —
follows from it.

```ts
await record({ device: 'iPhone 15 Pro' }, script) // preset
await record({ device: 'Pixel 7', aspect: '9:16' }, script) // preset, format overridden
await record(
  {
    device: {
      extends: 'Desktop Chrome HiDPI',
      capture: { width: 3200, height: 2000 },
    },
  },
  script,
)
```

## Where the values come from

Playwright ships **143 device profiles** (measured on the checked-out
`playwright-core`). They supply the lower, hard part: viewport, pixel ratio,
`isMobile`, `hasTouch`, user agent and the matching browser engine. We do not
copy that list — it is read from Playwright at run time, so that it stays
current with every update.

What Playwright does not know, because it is about testing and not about
filming, we lay on top:

| Layer     | Fields                                                                                     | Source                |
| --------- | ------------------------------------------------------------------------------------------ | --------------------- |
| Device    | `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`, `defaultBrowserType` | Playwright, unchanged |
| Capture   | `capture.width/height` (the area actually captured), `fps`, `quality`, `strategy`          | our own layer         |
| Output    | `aspect` (16:9 / 9:16 / 1:1), `output.width/height`, `crf` or NVENC level                  | our own layer         |
| Rendering | `pointer` (`arrow` \| `touch` \| `none`), pointer size, ripple colour                      | our own layer         |

**Desktop is deliberately captured larger than it is delivered.** All three
desktop presets capture 2560×1600 — more than any of their output formats
needs. The margin is not a buffer but the precondition for two things that
cannot exist without it: M4 cuts several formats out of **the same** raw
material without running the browser a second time, and the zoom spring frames
the element that was hit on every click — it travels around inside the capture
instead of upscaling. Neither can be had from a capture that already has the
output size. The same decision is stated in [PLAN.md](../PLAN.md).

What falls out of 2560×1600 without upscaling: 16:10 (1920×1200) with a 1.33×
reserve, 16:9 (1920×1080) with 1.33× in width and 1.48× in height, 1:1
(1080×1080) with 1.48×. What does **not** fall out: **9:16 (1080×1920).** The
tallest 9:16 crop from a 1600 pixel high frame is 900×1600 and would have to be
enlarged by 1.2× — exactly the thing this chain does nowhere. Portrait output
is the business of the mobile presets.

The reason for the separate capture layer is the central finding of the
research: **the capture delivers CSS pixels and ignores the device pixel
ratio.** A device profile alone therefore does not determine the video
resolution — with an iPhone profile it would be 393 pixels wide. The capture
layer is where that is corrected.

**Mobile is therefore captured differently from desktop, not merely smaller.**
A touch profile is filmed through a shell: the captured document has the size
of the video, the application inside it sits at the width of the device and is
drawn scaled up by a CSS transform — and is re-rasterised in the process, so it
is sharp. The shell is served from the application's own origin, otherwise the
application loses its storage and draws nothing. Capture and output area are
**the same size** here, without the desktop reserve; both measured and argued
in [M3-VERDICT.md](M3-VERDICT.md).

**A phone recording presents at 60 Hz, like desktop.** Until 2026-09-18 it did
not: every phone video was 30 Hz content in a 60 fps file, behind a yield gate
that stayed green (issue #116). The cause was not the shell, the scale, the
pixel density or the emulated device, but the finger. Chromium acknowledges a
touch move only after the frame it lands in — 33 ms — and the swipe waited for
each acknowledgement before sending the next step, so the page moved on every
second frame. The steps now go out on the clock. Measured with the yield
harness on `iphone` at 1080×1920: median gap between presented frames 33.34 ms
before, 16.69 ms after, with 84 % of gaps a single refresh against 88 % for a
pointer profile at the same size.

## Ordering a device, not just naming one

A run is given its devices in one of two places, and the command line wins over
the script:

```bash
pnpm featurecast run demo/fixture-tour.ts --devices desktop,tablet,iphone
```

```ts
// in the recording script
export const devices = [
  'desktop-wide',
  {
    extends: 'iphone',
    as: 'phone-with-reserve',
    capture: { width: 1620, height: 2880 },
  },
]
```

The script export is where anything beyond a name belongs, for the same reason
`url`, `storageStatePath`, `hideSelectors` and `fixedTime` live there: it is
knowable where the script is written and nowhere else. How much capture area a
particular journey needs is a property of that journey, not of the person who
types the command.

Every field of the resolution below can be overridden — capture area, frame
rate, JPEG quality, capture strategy, output size and quality, pointer shape,
pointer size, ripple colour, and `aspect` as a shorthand for the output size.
The refusals stay where they were: an unknown name, a capture smaller than the
output and a zoom that would need more than the capture holds are all answered
by the device and render layers, in one message each, not repeated here.

**`as` names the variant**, and exists because two variants of one preset would
otherwise collide. Both would want the directory `desktop`, and the second
would drop its files between the first one's frames; a run that would do that
is refused before any browser starts. Deriving a name from the overridden
fields instead was considered and dropped — it answers "which fields count"
with a guess, and a changed pointer colour would silently produce a second
directory nobody asked for.

Two things this unlocks that were previously unreachable without writing
TypeScript against the API: a capture area larger than 2560×1600, and a mobile
capture with room for the camera to move into. A phone preset records at
exactly its delivery size, which is why the renderer clamps every mobile zoom
to 1.00× — give it reserve and the push-in becomes possible. What that costs in
frame rate is measured, not assumed; see [M3-VERDICT.md](M3-VERDICT.md) and the
capture-area measurements referenced from it.

---

## Curated shortlist

Values taken directly from Playwright's registry. `Capture` and `Output` are
our own settings; both have now been proven (M1 for desktop, M3 for mobile).

| Preset                                  | Viewport (CSS) | Ratio | Touch | Engine   | Capture     | Output    | Pointer |
| --------------------------------------- | -------------- | ----- | ----- | -------- | ----------- | --------- | ------- |
| `desktop` → Desktop Chrome HiDPI        | 1280×720       | 2     | –     | chromium | 2560×1600   | 1920×1080 | arrow   |
| `desktop-wide` → Desktop Chrome         | 1280×720       | 1     | –     | chromium | 2560×1600   | 1920×1200 | arrow   |
| `safari` → Desktop Safari               | 1280×720       | 2     | –     | webkit   | 2560×1600   | 1920×1080 | arrow   |
| `iphone` → iPhone 15 Pro                | 393×659        | 3     | yes   | webkit   | 1080×1920 S | 1080×1920 | touch   |
| `iphone-max` → iPhone 15 Pro Max        | 430×739        | 3     | yes   | webkit   | 1080×1920 S | 1080×1920 | touch   |
| `iphone-small` → iPhone SE              | 320×568        | 2     | yes   | webkit   | 1080×1920 S | 1080×1920 | touch   |
| `iphone-quer` → iPhone 15 Pro landscape | 734×343        | 3     | yes   | webkit   | 1920×1080 S | 1920×1080 | touch   |
| `android` → Pixel 7                     | 412×839        | 2.625 | yes   | chromium | 1080×1920 S | 1080×1920 | touch   |
| `android-small` → Galaxy S24            | 360×780        | 3     | yes   | chromium | 1080×1920 S | 1080×1920 | touch   |
| `tablet` → iPad Pro 11                  | 834×1194       | 2     | yes   | webkit   | 1200×1600 S | 1200×1600 | touch   |
| `tablet-small` → iPad Mini              | 768×1024       | 2     | yes   | webkit   | 1200×1600 S | 1200×1600 | touch   |

`S` marks the captures that run through the shell (strategy `framed-scale`) —
exactly the touch profiles. Each of the 143 Playwright names also works
directly, without a preset. The shortlist exists only so that a later dropdown
has twelve sensible entries instead of 143.

## The 4K preset, and what it does not promise

`desktop-4k` records and delivers 3840×2160. It exists because "can it do 4K"
is a fair question and the answer used to be "only by editing the source".

Two things it deliberately does not claim:

**Not 4K at 60 frames a second.** Measured on the benchmark machine
2026-09-17: capture yield 98.60 % (282 of 286 presented frames), gate cleared,
frames sharp and intact — recording at this size is not the problem. The
cadence is. At 2560×1600 the browser presents a frame every 16.76 ms in the
median and 84.8 % of the gaps are one full 60 Hz interval; at 3840×2160 it is
20.52 ms and half. So: 4K, yes. 4K at 60, no, and saying so would be claiming
more than was measured.

**The camera holds still.** Output equals capture area, so there is no reserve
to crop into and every push-in is clamped to 1.00× — the same trade the mobile
presets make. A run that wants a large picture _and_ a moving camera asks for
the two sizes separately:

```ts
export const devices = [
  {
    extends: 'desktop',
    as: 'desktop-roomy',
    capture: { width: 3840, height: 2160 },
  },
]
```

That keeps `desktop`'s own 1920×1080 delivery and leaves a 2× reserve — a
sharper 1080p with a far more dramatic camera move than the 1.33× the standard
desktop area affords. It costs the same 35 % more recording time as the 4K
preset, and the frames are 826 KB each instead of 452 KB.

---

## A note on engines

The iPhone and iPad profiles run under WebKit according to the registry.
Whether the capture interface works there the same way as under Chromium is
**still unchecked**: M3 measured everything under Chromium with the iPhone
profile. That is exactly the route that was left open — drive the same device
characteristics under Chromium: the layout is right, Safari's engine quirks are
missing. For marketing material that is defensible; for tests it would not be.

## Implementation (M5)

The code is in [`src/devices.ts`](../src/devices.ts); the entry point is
`resolveDevice(spec)`, which builds the full description from a name, a preset,
or a preset plus overrides. The connection to `record()` has not been wired up
yet — how it is intended is described in the module's header comment.

Four points that had to be decided concretely while building:

**The registry is larger than noted here.** The checked-out `playwright` 1.63.0
supplies **207** names (107 devices plus 100 `… landscape` variants), not the
143 noted above. The twelve curated names and all the characteristics in the
table still match the registry exactly — checked in the test. That discrepancy
is precisely the reason to read the list at run time.

**`aspect` is an input shorthand and a derived label, not a stored field.** Two
presets carry output sizes that match none of the three aspect ratios:
`desktop-wide` at 1920×1200 (16:10) and `tablet`/`tablet-small` at 1200×1600
(3:4). What is stored is therefore only `output.width`/`height`;
`aspect: '9:16'` in the invocation sets both from a fixed table (1920×1080 /
1080×1920 / 1080×1080), and `aspectOf()` returns the label or `null`. An
additionally stored `aspect` would contradict the stored pixel size on those
two presets.

**"Capture: open (M3)" no longer exists.** Until 2026-09-15 the eight mobile
presets carried a state of their own, `pending`, which aborted on use and named
the milestone. M3 answered the question, so the state is gone — together with
the two strategies that were measured and rejected. What was open now stands as
a result in [M3-VERDICT.md](M3-VERDICT.md) and not as a dead branch in the code.

**The pointer follows `hasTouch`.** The pointer column of the table is exactly
the touch capability of the profile (arrow on the three desktop profiles, touch
on the eight mobile ones), so it is derived rather than written down a second
time. Pointer size (24 px) and ripple colour are overridable placeholders and
belong to M4; `crf 23` is not a new choice but libx264's default value, and
therefore what the existing assembly stage already produces anyway.
