# cadence — how many written frames carry a new picture

```bash
node tools/cadence/cadence.mjs <video.mp4> [width]
```

```
supercut-aurora.mp4
  frames=652 size=1920x1080 container_fps=60.00 repeats=293/651 (45.0%)
  effective_fps=33.0 [gray 960x540, pixel-noise>8, repeat if <40 px moved]
```

## What it answers, and what it does not

A container says 60 frames a second. That is a number in a header. If every
second frame repeats its predecessor, the picture moves 30 times a second and
`ffprobe` will still say 60. This tool reads the picture instead of the
header, and it is the same command for every tool's output, which is the only
way a comparison between tools means anything.

It answers **"how many written frames are empty"**. It does **not** answer
"which tool looks smoother": the share counts the deliberate pauses of a
journey too, so a tool that compresses the same actions into seven seconds and
one that lets them breathe for thirty have different amounts of stillness in
the denominator. For a smoothness verdict see `tools/smoothness/`, which
refuses to judge without a recording's own motion windows.

## Why not ffmpeg's own tools

Both were built first and thrown away, and both would have produced plausible
numbers:

- **`-f framehash`**, comparing neighbouring frames bit for bit. Re-encoding
  moves pixels, so a genuine repeat is no longer bit-identical afterwards. On
  the calibration clip "30 fps in a 60 fps container" it reported 0 % instead
  of 50 %.
- **`-vf mpdecimate`**. At its defaults it counts a frame in which only the
  mouse pointer moved as a repeat — and a screen recording is mostly exactly
  that. With `frac=0` this build behaved opposite to its documentation and
  reported 100 % repeats on a clip with real motion.

## How it decides

ffmpeg decodes to 8-bit grayscale at 960 px wide. For each consecutive pair it
counts pixels differing by more than 8 grey levels — above any H.264 or ProRes
ringing seen here, far below the contrast of a cursor on any background. A
pair with fewer than 40 changed pixels is a repeat; 40 out of 960×540 is a
tenth of the area a 12×18 px cursor still covers after the downscale.

## Calibration

`tests/cadence.integration.test.ts` builds five clips with a known answer and
fails if the instrument does not return it. The last two are the reason
`mpdecimate` was rejected: they separate "much of the picture moves" from
"little of the picture moves, but every frame".

| Clip                                              | expected |
| ------------------------------------------------- | -------- |
| `testsrc2` at 60 fps, full-frame motion           | 0 %      |
| the same at 30 fps inside a 60 fps container      | 50 %     |
| a still image at 60 fps                           | 100 %    |
| a 12×18 px dot, moving every frame (cursor-sized) | 0 %      |
| the same dot at 30 fps inside a 60 fps container  | 50 %     |

## Requirements

Node and `ffmpeg`/`ffprobe` on the path. No dependencies — this is why it is a
plain `.mjs` file rather than a package.
