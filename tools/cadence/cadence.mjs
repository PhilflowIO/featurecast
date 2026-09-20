// Motion cadence on a finished video — one command, identical for every tool.
//   node kadenz.mjs <video> [--w 960]
//
// ffmpeg decodes the video to full-resolution 8-bit grayscale; this counts,
// for every consecutive frame pair, how many pixels differ by more than a
// codec-noise floor. A pair whose changed-pixel count is at or below the
// floor is a REPEAT: the tool wrote a frame into the container that carries
// no new picture. The share of repeats is what separates a file that says
// 60 fps from a picture that moves 60 times a second.
import { spawn } from 'node:child_process'

const video = process.argv[2]
const W = Number(process.argv[3] ?? 960)
if (!video) {
  console.error('usage: node kadenz.mjs <video> [width]')
  process.exit(1)
}

const probe = (args) =>
  new Promise((res) => {
    const p = spawn('ffprobe', args)
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => res(out.trim().replace(/,+$/, '')))
  })

const fps = await probe([
  '-v',
  'error',
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=avg_frame_rate',
  '-of',
  'csv=p=0',
  video,
])
const meta = await probe([
  '-v',
  'error',
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=width,height',
  '-of',
  'csv=p=0',
  video,
])
const [srcW, srcH] = meta.split(',').map(Number)
const H = Math.max(2, Math.round(((srcH / srcW) * W) / 2) * 2)

// 8 grey levels of difference is above any H.264/ProRes ringing seen here and
// far below the contrast of a cursor arrow on any background.
const PIXEL_NOISE = 8
// a pair is a repeat when fewer than this many pixels moved at all — 40 of
// 960x540 is a tenth of the area a 12x18 cursor covers after the downscale.
const PIXEL_FLOOR = 40

const ff = spawn(
  'ffmpeg',
  [
    '-v',
    'error',
    '-i',
    video,
    '-an',
    '-vf',
    `scale=${W}:${H}:flags=bicubic,format=gray`,
    '-f',
    'rawvideo',
    '-',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)

const frameBytes = W * H
let buf = Buffer.alloc(0)
let prev = null,
  frames = 0,
  repeats = 0
let changedPerPair = []

for await (const chunk of ff.stdout) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
  while (buf.length >= frameBytes) {
    const f = buf.subarray(0, frameBytes)
    buf = buf.subarray(frameBytes)
    frames++
    if (prev) {
      let changed = 0
      for (let i = 0; i < frameBytes; i++) {
        const d = f[i] - prev[i]
        if (d > PIXEL_NOISE || d < -PIXEL_NOISE) changed++
      }
      changedPerPair.push(changed)
      if (changed < PIXEL_FLOOR) repeats++
    }
    prev = Buffer.from(f)
  }
}
const pairs = frames - 1
const share = pairs > 0 ? (100 * repeats) / pairs : 0
const num = fps.split('/').map(Number)
const nominal = num[1] ? num[0] / num[1] : Number(fps)
console.log(
  `${video}\n  frames=${frames} size=${srcW}x${srcH} container_fps=${nominal.toFixed(2)} ` +
    `repeats=${repeats}/${pairs} (${share.toFixed(1)}%) effective_fps=${(nominal * (1 - share / 100)).toFixed(1)} ` +
    `[gray ${W}x${H}, pixel-noise>${PIXEL_NOISE}, repeat if <${PIXEL_FLOOR} px moved]`,
)
