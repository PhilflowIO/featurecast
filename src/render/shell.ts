import { Canvas, fillPolygon, type Point, type Rgba } from './sprite.js'

/**
 * Device shells, drawn here rather than licensed as artwork.
 *
 * The shot this exists for is the one every product page opens with: the same
 * application on a monitor, a tablet and a phone at once. Shipping somebody's
 * mockup PNG would mean carrying its licence and its fixed aspect ratios; a
 * shell drawn from the recording's own dimensions has neither problem, and
 * `src/render/sprite.ts` already writes RGBA rasters as PNG with Node's own
 * zlib, so this adds no dependency and the same input yields the same bytes.
 *
 * Every proportion below is a fraction of the screen's width, so a shell is
 * whatever size its recording is and nothing has to be typed in twice.
 */

export type ShellKind = 'monitor' | 'laptop' | 'tablet' | 'phone'

export const SHELL_KINDS: readonly ShellKind[] = [
  'monitor',
  'laptop',
  'tablet',
  'phone',
]

export function isShellKind(value: string): value is ShellKind {
  return (SHELL_KINDS as readonly string[]).includes(value)
}

type Proportions = {
  /** Bezel left, right and top, as a fraction of screen width. */
  bezel: number
  /** Bezel below the screen; a monitor and a laptop have a deeper one. */
  chin: number
  /** Outer corner radius, as a fraction of screen width. */
  radius: number
  /** Neck and base of a monitor stand, or the wedge under a laptop. */
  stand: {
    width: number
    height: number
    footWidth: number
    footHeight: number
  }
  /** A phone's camera island, as a fraction of screen width; 0 for none. */
  island: number
}

/**
 * Chosen by eye against real devices, not measured off one product: a
 * monitor's chin carries a brand, a tablet's bezel is even all round, a
 * phone's corners are nearly a quarter of its width.
 */
const PROPORTIONS: Record<ShellKind, Proportions> = {
  monitor: {
    bezel: 0.016,
    chin: 0.05,
    radius: 0.014,
    stand: { width: 0.13, height: 0.1, footWidth: 0.36, footHeight: 0.022 },
    island: 0,
  },
  laptop: {
    bezel: 0.019,
    chin: 0.055,
    radius: 0.016,
    stand: { width: 0, height: 0, footWidth: 1.28, footHeight: 0.035 },
    island: 0,
  },
  tablet: {
    bezel: 0.036,
    chin: 0.036,
    radius: 0.055,
    stand: { width: 0, height: 0, footWidth: 0, footHeight: 0 },
    island: 0,
  },
  phone: {
    bezel: 0.032,
    chin: 0.032,
    radius: 0.125,
    stand: { width: 0, height: 0, footWidth: 0, footHeight: 0 },
    island: 0.3,
  },
}

const BODY: Rgba = [26, 31, 38, 255]
const BODY_EDGE: Rgba = [58, 66, 78, 255]
const STAND: Rgba = [42, 48, 57, 255]
const ISLAND: Rgba = [10, 12, 15, 255]
const SHADOW: Rgba = [15, 20, 28, 26]

/** How far the shadow reaches, and how far it is offset down, in pixels. */
const SHADOW_SPREAD = 14
const SHADOW_DROP = 10

export type ShellScreen = {
  height: number
  width: number
  x: number
  y: number
}

export type Shell = {
  height: number
  kind: ShellKind
  /** Where the recording goes, in shell pixels. */
  screen: ShellScreen
  width: number
}

function even(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/**
 * The shell that holds a recording of exactly this size. The screen area is
 * the recording's own size, never a letterboxed fit into a fixed frame: a
 * 9:16 phone take and a 16:10 desktop take get differently shaped shells,
 * which is the whole point of filming each device separately.
 */
export function shellGeometry(
  kind: ShellKind,
  screenWidth: number,
  screenHeight: number,
): Shell {
  if (screenWidth <= 0 || screenHeight <= 0) {
    throw new Error(
      `A ${kind} shell needs a positive screen size, got ${String(screenWidth)}x${String(screenHeight)}`,
    )
  }
  const p = PROPORTIONS[kind]
  const bezel = Math.round(p.bezel * screenWidth)
  const chin = Math.round(p.chin * screenWidth)
  const bodyWidth = even(screenWidth + bezel * 2)
  const bodyHeight = even(screenHeight + bezel + chin)
  const standHeight = Math.round(p.stand.height * screenWidth)
  const footHeight = Math.round(p.stand.footHeight * screenWidth)
  const footWidth = Math.round(p.stand.footWidth * bodyWidth)
  const width = even(Math.max(bodyWidth, footWidth) + SHADOW_SPREAD * 2)
  const height = even(
    bodyHeight + standHeight + footHeight + SHADOW_SPREAD + SHADOW_DROP,
  )
  const bodyX = Math.round((width - bodyWidth) / 2)
  return {
    height,
    kind,
    screen: {
      height: screenHeight,
      width: screenWidth,
      x: bodyX + bezel,
      y: SHADOW_SPREAD + bezel,
    },
    width,
  }
}

function roundedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): Point[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  if (r === 0) {
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ]
  }
  const steps = 10
  const corners: readonly [number, number, number][] = [
    [x + width - r, y + r, -Math.PI / 2],
    [x + width - r, y + height - r, 0],
    [x + r, y + height - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ]
  const points: Point[] = []
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i += 1) {
      const angle = start + (Math.PI / 2) * (i / steps)
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
    }
  }
  return points
}

/**
 * A soft edge without a blur kernel: the silhouette is filled a handful of
 * times, each ring a little larger and a little fainter. Cheap, deterministic,
 * and enough to lift a shell off a white page.
 */
function dropShadow(canvas: Canvas, body: Point[], radius: number): void {
  const xs = body.map((point) => point.x)
  const ys = body.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(...xs) - x
  const height = Math.max(...ys) - y
  for (let step = SHADOW_SPREAD; step > 0; step -= 2) {
    fillPolygon(
      canvas,
      roundedRect(
        x - step,
        y - step + SHADOW_DROP,
        width + step * 2,
        height + step * 2,
        radius + step,
      ),
      SHADOW,
    )
  }
}

/**
 * The shell as an RGBA raster with a transparent screen area: the recording is
 * laid underneath it at `shell.screen`, so nothing of the picture is covered
 * and no second scaling pass touches it.
 */
export function drawShell(shell: Shell): Canvas {
  const p = PROPORTIONS[shell.kind]
  const canvas = new Canvas(shell.width, shell.height)
  const bezel = Math.round(p.bezel * shell.screen.width)
  const chin = Math.round(p.chin * shell.screen.width)
  const radius = Math.round(p.radius * shell.screen.width)
  const bodyX = shell.screen.x - bezel
  const bodyY = shell.screen.y - bezel
  const bodyWidth = shell.screen.width + bezel * 2
  const bodyHeight = shell.screen.height + bezel + chin
  const body = roundedRect(bodyX, bodyY, bodyWidth, bodyHeight, radius)

  dropShadow(canvas, body, radius)

  const standWidth = Math.round(p.stand.width * shell.screen.width)
  const standHeight = Math.round(p.stand.height * shell.screen.width)
  const footWidth = Math.round(p.stand.footWidth * bodyWidth)
  const footHeight = Math.round(p.stand.footHeight * shell.screen.width)
  const centerX = bodyX + bodyWidth / 2
  if (standHeight > 0 && standWidth > 0) {
    fillPolygon(
      canvas,
      roundedRect(
        centerX - standWidth / 2,
        bodyY + bodyHeight - radius,
        standWidth,
        standHeight + radius,
        0,
      ),
      STAND,
    )
  }
  if (footHeight > 0 && footWidth > 0) {
    const footY = bodyY + bodyHeight + standHeight
    fillPolygon(
      canvas,
      shell.kind === 'laptop'
        ? [
            { x: centerX - bodyWidth / 2, y: footY },
            { x: centerX + bodyWidth / 2, y: footY },
            { x: centerX + footWidth / 2, y: footY + footHeight },
            { x: centerX - footWidth / 2, y: footY + footHeight },
          ]
        : roundedRect(
            centerX - footWidth / 2,
            footY,
            footWidth,
            footHeight,
            footHeight / 2,
          ),
      STAND,
    )
  }

  // Body over stand, so the neck disappears behind the panel rather than
  // drawing a seam across it.
  fillPolygon(canvas, body, BODY_EDGE)
  fillPolygon(
    canvas,
    roundedRect(
      bodyX + 1,
      bodyY + 1,
      bodyWidth - 2,
      bodyHeight - 2,
      Math.max(0, radius - 1),
    ),
    BODY,
  )

  // Punch the screen out again: the recording shows through here.
  const screen = roundedRect(
    shell.screen.x,
    shell.screen.y,
    shell.screen.width,
    shell.screen.height,
    Math.max(0, radius - bezel),
  )
  clear(canvas, screen)

  if (p.island > 0) {
    const islandWidth = Math.round(p.island * shell.screen.width)
    const islandHeight = Math.round(islandWidth / 3.1)
    fillPolygon(
      canvas,
      roundedRect(
        shell.screen.x + (shell.screen.width - islandWidth) / 2,
        shell.screen.y + Math.round(bezel * 0.55),
        islandWidth,
        islandHeight,
        islandHeight / 2,
      ),
      ISLAND,
    )
  }
  return canvas
}

/** Sets every covered pixel fully transparent, the one thing blend cannot do. */
function clear(canvas: Canvas, points: readonly Point[]): void {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.max(0, Math.floor(Math.min(...xs)))
  const maxX = Math.min(canvas.width - 1, Math.ceil(Math.max(...xs)))
  const minY = Math.max(0, Math.floor(Math.min(...ys)))
  const maxY = Math.min(canvas.height - 1, Math.ceil(Math.max(...ys)))
  const mask = new Canvas(canvas.width, canvas.height)
  fillPolygon(mask, points, [255, 255, 255, 255])
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const index = (y * canvas.width + x) * 4
      const coverage = (mask.pixels[index + 3] ?? 0) / 255
      if (coverage <= 0) continue
      const alpha = (canvas.pixels[index + 3] ?? 0) / 255
      canvas.pixels[index + 3] = Math.max(0, alpha - coverage) * 255
    }
  }
}
