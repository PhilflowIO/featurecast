/**
 * The one vocabulary for "which encoder produces the video", and the one
 * place it is translated into ffmpeg's `-c:v` names.
 *
 * ## Why featurecast's own names rather than ffmpeg's
 *
 * Until this module existed the same decision had two spellings that nothing
 * connected: the device layer offered `'x264' | 'nvenc'`
 * (`OutputQuality.encoder`, src/devices.ts) while the assemble stage offered
 * `'libx264' | 'h264_nvenc' | 'hevc_nvenc'` (`ENCODERS`, src/assemble.ts).
 * Two namespaces for one choice means every path between them is a hand
 * translation waiting to be written wrong, and the device layer's encoder
 * field could not be handed to `buildFfmpegArguments` at all.
 *
 * The rejected alternative was to spell ffmpeg's names everywhere and delete
 * the device layer's own. It is honest — nobody has to learn a second set of
 * words — and it costs no mapping. It was rejected because it makes the
 * device presets in docs/DEVICES.md, the CLI flag a user types, and any
 * stored recording description depend on the naming of one particular
 * command-line tool: `libx264` is not a property of the video anyone wants,
 * it is the name of a library ffmpeg happens to link. Moving off ffmpeg, or
 * adding a second backend, would then either break every preset or keep
 * `hevc_nvenc` as a name for something that is no longer NVENC.
 *
 * So: featurecast names in every interface, exactly one table
 * (`ENCODER_PROFILES`) at the boundary to ffmpeg, and nothing else in the
 * repository may contain an ffmpeg codec string. `tests/encoders.test.ts`
 * pins the table entry by entry and `tests/assemble.test.ts` pins that the
 * built command carries what the table says.
 */

/** Which hardware the encode runs on, and hence which rate-control dialect. */
export type EncoderFamily = 'nvenc' | 'x264'

export type EncoderProfile = {
  /** The `-c:v` argument. The only ffmpeg-specific string in the repository. */
  ffmpegCodec: string
  family: EncoderFamily
}

/**
 * The encoder names featurecast speaks, and their single translation.
 *
 * `x264` runs on the CPU and stays the default; the two `nvenc-*` entries
 * hand the encode to the 3090's dedicated encoder block. NVENC exists here
 * because the measured CPU cost is the problem, not a convenience: PLAN.md
 * records 1 minute 45 for 8 seconds of 1080p60 through the post-processing
 * chain on CPU. It is nonetheless *not* the default, and deliberately so —
 * nobody has yet run M6's acceptance measurement ("die Laufzeit fuer 30
 * Sekunden 1080p60 wird gemessen und notiert") or looked at an NVENC-encoded
 * result next to an x264 one. Until that has happened, the path whose output
 * has actually been seen is the one that runs unless a caller asks for the
 * other.
 */
const ENCODER_PROFILES = {
  'nvenc-h264': { ffmpegCodec: 'h264_nvenc', family: 'nvenc' },
  'nvenc-hevc': { ffmpegCodec: 'hevc_nvenc', family: 'nvenc' },
  x264: { ffmpegCodec: 'libx264', family: 'x264' },
} as const satisfies Readonly<Record<string, EncoderProfile>>

export type Encoder = keyof typeof ENCODER_PROFILES

/** Every encoder name, sorted, for error messages and exhaustiveness tests. */
export const ENCODERS: readonly Encoder[] = Object.keys(
  ENCODER_PROFILES,
).sort() as Encoder[]

/** The encoder used unless a caller names another one. */
export const DEFAULT_ENCODER: Encoder = 'x264'

/** The translation. Call it at the ffmpeg boundary and nowhere else. */
export function encoderProfile(encoder: Encoder): EncoderProfile {
  return ENCODER_PROFILES[encoder]
}

/**
 * Resolves an encoder name from outside (CLI flag, config file) and refuses
 * anything else by name, the way `resolveDevice` does for device presets: a
 * typo that silently fell back to the CPU path would be found only by
 * noticing the encode took two minutes.
 */
export function resolveEncoder(name: string): Encoder {
  const match = ENCODERS.find((encoder) => encoder === name)
  if (match !== undefined) return match
  throw new Error(
    `Unknown encoder "${name}". Available: ${ENCODERS.join(', ')}`,
  )
}

/**
 * Encoder plus the quality number that encoder understands.
 *
 * `crf` belongs to the CPU path and `cq` to NVENC: different scales with the
 * same nominal range, which is why they are different fields rather than one
 * `quality` number. The encoder name is the vocabulary above, so this whole
 * value can be handed to the assemble stage unchanged — that is the point of
 * it existing here rather than in the device layer.
 */
export type OutputQuality =
  | { cq: number; encoder: Extract<Encoder, `nvenc-${string}`> }
  | { crf: number; encoder: Extract<Encoder, 'x264'> }

/**
 * The quality number both scales default to.
 *
 * This is the one number that has to be chosen rather than copied. libx264's
 * own default is constant quality at CRF 23 with no bitrate ceiling, so 23 on
 * the CPU path changes nothing about what the encoder has always produced.
 * NVENC's default is the opposite kind of promise — a bitrate target — and a
 * screencast of a dense scrolling UI is exactly the material that target
 * starves, so the GPU path is pinned to constant quality at the same number.
 *
 * What is *not* claimed: that CQ 23 and CRF 23 are perceptually equal. The
 * two scales belong to different encoders and the correspondence is
 * unmeasured here. That open question is the same reason `DEFAULT_ENCODER`
 * is still the CPU.
 */
export const DEFAULT_CONSTANT_QUALITY = 23

/** The default quality for an encoder, on whichever scale it speaks. */
export function defaultQualityFor(encoder: Encoder): OutputQuality {
  return encoder === 'x264'
    ? { crf: DEFAULT_CONSTANT_QUALITY, encoder }
    : { cq: DEFAULT_CONSTANT_QUALITY, encoder }
}

/** Default encoder settings: the CPU path at its own native default. */
export const DEFAULT_OUTPUT_QUALITY: OutputQuality =
  defaultQualityFor(DEFAULT_ENCODER)

/** The quality number this value carries, and what that number is called. */
export function qualityNumber(quality: OutputQuality): {
  field: 'cq' | 'crf'
  value: number
} {
  // Discriminating on the present field rather than on the encoder name
  // keeps a fourth encoder from needing an edit here as well as in the
  // profile table.
  return 'crf' in quality
    ? { field: 'crf', value: quality.crf }
    : { field: 'cq', value: quality.cq }
}
