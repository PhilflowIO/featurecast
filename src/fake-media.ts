import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

import type { BrowserContext } from 'playwright'

/**
 * A synthetic camera and microphone that play *files* instead of Chromium's
 * test picture and tone (featurecast#166).
 *
 * `fakeMedia = true` is enough to keep a video-call page out of its "no
 * camera" state, but the person on the tile is then a green test pattern and
 * their speaking indicator never lights. A scene in which the filmed person is
 * a persona needs their face on the camera and their voice on the microphone.
 *
 * **The camera** is Chromium's own route: `--use-file-for-fake-video-capture`
 * plays a Y4M or MJPEG file as the fake camera, looped. Nothing else is
 * needed, and nothing else is as cheap.
 *
 * **The microphone is not.** Chromium's sibling switch,
 * `--use-file-for-fake-audio-capture`, starts the file at the moment the page
 * opens the microphone. For a single speaker that is fine; for a meeting it is
 * the problem. Several browsers — this recording and the other participants,
 * joined from another tool — open their microphones at different moments, so
 * their tracks run against each other: people talk over one another and the
 * pauses land in the wrong places. So the microphone is an init script instead:
 * it replaces `getUserMedia` for audio and plays the file through WebAudio,
 * looped and *positioned on the wall clock*. Whoever listens at instant `t`
 * hears second `(t − startsAt) mod duration` of the file, no matter when the
 * page opened its microphone or how often it reopened it. Every browser that
 * anchors its own track at the same `startsAt` speaks on the same timeline.
 *
 * The wall clock here is `performance.timeOrigin + performance.now()`, NOT
 * `Date.now()`: `fixedTime` replaces `Date` in every document of a recording
 * (`pinClockAndRandomness` in src/recipes.ts), and a schedule read from a
 * pinned clock would be off by however far the pin is from today.
 */
export type FakeMicrophone = {
  /** Audio file the browser can decode (WAV is the safe choice). */
  file: string
  /**
   * Wall-clock anchor in epoch milliseconds. Absent: the moment the page
   * first opens its microphone, which is what Chromium's own switch does.
   */
  startsAt?: number
}

export type FakeMediaFiles = {
  /** A Y4M or MJPEG file played as the camera. */
  camera?: string
  microphone?: FakeMicrophone
  /**
   * A video file handed to the page when it asks to share a screen
   * (featurecast#190).
   *
   * Chromium's own route does not work here and that is measured, not
   * assumed: in the headless recording browser `getDisplayMedia` DOES return
   * a live track — 1280x720@30 — but with `--use-fake-device-for-media-stream`
   * its source is the synthetic screen, labelled `screen:-3:0` under BOTH
   * `--auto-select-tab-capture-source-by-title` and
   * `--auto-select-desktop-capture-source`. A test pattern, not a tab and not
   * a desktop. (Measured 2026-09-19 on the recording image, against a secure
   * origin — on `about:blank` there is no `navigator.mediaDevices` at all.)
   *
   * So the screen is fed from a file, exactly as the microphone is: the page
   * gets back a stream captured from a `<video>` playing this file, looped.
   * What the room then sees is whatever we chose to put in it — and the
   * honest choice is footage of the product itself.
   */
  screen?: string
}

/**
 * What a session is asked for: nothing, Chromium's synthetic devices (`true`),
 * or those devices with files in place of the picture and/or the tone.
 */
export type FakeMedia = boolean | FakeMediaFiles

/** The two switches every variant of fake media starts with. */
export const FAKE_MEDIA_LAUNCH_ARGS: readonly string[] = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
]

/**
 * The permissions granted alongside the switches. The switches make the
 * prompt say yes; the grant makes `navigator.permissions.query` say
 * `granted` before anything has been asked, which is what a page that checks
 * first (instead of simply calling `getUserMedia`) reads.
 */
export const FAKE_MEDIA_PERMISSIONS: readonly string[] = [
  'camera',
  'microphone',
]

/** Whether the request switches fake media on at all. */
export function wantsFakeMedia(fakeMedia: FakeMedia | undefined): boolean {
  return fakeMedia !== undefined && fakeMedia !== false
}

/**
 * The launch switches for a request.
 *
 * The autoplay switch comes with a microphone file and only then: the voice is
 * an `AudioContext`, and a headless page never receives the user gesture that
 * would otherwise be required to start one. Without it the track is silent
 * and nothing says so.
 */
export function fakeMediaLaunchArgs(
  fakeMedia: FakeMedia | undefined,
): string[] {
  if (!wantsFakeMedia(fakeMedia)) return []
  const args = [...FAKE_MEDIA_LAUNCH_ARGS]
  if (typeof fakeMedia === 'object') {
    if (fakeMedia.camera !== undefined) {
      args.push(
        `--use-file-for-fake-video-capture=${resolve(fakeMedia.camera)}`,
      )
    }
    if (fakeMedia.microphone !== undefined || fakeMedia.screen !== undefined) {
      // Both the voice and the shared picture are media a headless page has
      // to start without ever receiving a user gesture.
      args.push('--autoplay-policy=no-user-gesture-required')
    }
  }
  return args
}

/** Where the page fetches the microphone file from; answered by a route. */
export const MICROPHONE_PATH = '/__featurecast/microphone'

/**
 * The init script, as a string for the reason `docs/RECORDING-SCRIPTS.md`
 * gives under "The trap that catches every injected script": a compiled
 * function would carry esbuild's `__name` into a page that has none.
 *
 * One `AudioContext` and one bus per document; every audio `getUserMedia`
 * gets its own destination on that bus, because a call page opens the
 * microphone more than once (LiveKit: once on the pre-join card, once in the
 * room, stopping the first track) and each open has to carry the same voice
 * at the same position. A request that also wants video gets the real (fake
 * or file-fed) camera from the original call, with the audio track swapped in.
 */
export function microphoneInitScript(startsAt: number | undefined): string {
  return `(function () {
  var md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  var original = md.getUserMedia.bind(md);
  var ctx = null;
  var bus = null;
  var anchor = ${startsAt === undefined ? 'null' : String(startsAt)};
  var wall = function () { return performance.timeOrigin + performance.now(); };
  var ensure = function () {
    if (ctx) return;
    if (anchor === null) anchor = wall();
    ctx = new AudioContext({ sampleRate: 48000 });
    bus = ctx.createGain();
    var c = ctx;
    var b = bus;
    fetch(${JSON.stringify(MICROPHONE_PATH)})
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (a) { return c.decodeAudioData(a); })
      .then(function (buffer) {
        return c.resume().then(function () {
          var source = c.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          source.connect(b);
          var delay = (anchor - wall()) / 1000;
          if (delay >= 0) source.start(c.currentTime + delay);
          else source.start(0, -delay % buffer.duration);
        });
      })
      .catch(function (e) { console.error('[featurecast] microphone file:', e); });
  };
  md.getUserMedia = function (constraints) {
    if (!constraints || !constraints.audio) return original(constraints);
    ensure();
    var destination = ctx.createMediaStreamDestination();
    bus.connect(destination);
    var video = constraints.video
      ? original({ video: constraints.video })
      : Promise.resolve(new MediaStream());
    return video.then(function (stream) {
      destination.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
      return stream;
    });
  };
})();`
}

/**
 * Installs the file-fed microphone on a context: the file is served on the
 * page's own origin (so neither CORS nor a content-security policy stands in
 * the way; the route answers before the network does), and the init script
 * reaches every document, including a framed application's.
 *
 * Before the first page, like every other context-level setting: an init
 * script only reaches documents opened after it.
 */
export async function installFakeMicrophone(
  context: BrowserContext,
  microphone: FakeMicrophone,
): Promise<void> {
  const body = await readFile(microphone.file)
  await context.route(`**${MICROPHONE_PATH}`, (route) =>
    route.fulfill({ body, contentType: contentTypeOf(microphone.file) }),
  )
  await context.addInitScript(microphoneInitScript(microphone.startsAt))
}

function contentTypeOf(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
    case '.opus':
      return 'audio/ogg'
    case '.flac':
      return 'audio/flac'
    // The screen file is a video and travels the same route (#190). A wrong
    // type here is not cosmetic: a `<video>` served `audio/wav` never fires
    // `playing`, and the share then hangs instead of failing.
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    default:
      return 'audio/wav'
  }
}

/**
 * Reads a script's `fakeMedia` export, strictly.
 *
 * `true`/`false` as before. An object may name `camera` (a Y4M or MJPEG file),
 * `microphone` (a file, or `{ file, startsAt }` with `startsAt` as epoch
 * milliseconds or an ISO instant) and `screen` (a video handed to the page when
 * it asks to share a screen). Files have to exist now: a missing face is a
 * browser that falls back to the green test picture and records it without
 * complaint.
 */
export function readFakeMedia(value: unknown, path: string): FakeMedia {
  // A boolean and nothing that merely looks like one: `'false'` is a truthy
  // string, and a camera switched on by the word "false" is exactly the kind
  // of silent pass this exists to refuse.
  if (typeof value === 'boolean') return value
  const refuse = (why: string): Error =>
    new Error(
      `"${path}" exports \`fakeMedia\`, which has to be a boolean or ` +
        "`{ camera?: 'face.y4m', microphone?: 'voice.wav' | { file, startsAt }, " +
        "screen?: 'geteilt.mp4' }`: " +
        `${why}.`,
    )
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refuse('it is neither')
  }
  const record = value as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== 'camera' && key !== 'microphone' && key !== 'screen',
  )
  if (unknownKeys.length > 0) {
    throw refuse(
      `unknown field ${unknownKeys.map((k) => `\`${k}\``).join(', ')}`,
    )
  }
  const result: FakeMediaFiles = {}

  const camera = record['camera']
  if (camera !== undefined) {
    if (typeof camera !== 'string' || camera === '') {
      throw refuse('`camera` has to be a file path')
    }
    const ext = extname(camera).toLowerCase()
    if (ext !== '.y4m' && ext !== '.mjpeg' && ext !== '.mjpg') {
      throw refuse(
        `\`camera\` is "${camera}"; Chromium plays only .y4m and .mjpeg files as a camera`,
      )
    }
    if (!existsSync(camera))
      throw refuse(`\`camera\` "${camera}" does not exist`)
    result.camera = camera
  }

  const screen = record['screen']
  if (screen !== undefined) {
    if (typeof screen !== 'string' || screen === '') {
      throw refuse('`screen` has to be a file path')
    }
    if (!/\.(mp4|m4v|webm)$/i.test(screen)) {
      throw refuse(
        `\`screen\` is "${screen}"; it is played in a <video>, so it has to be ` +
          `.mp4, .m4v or .webm`,
      )
    }
    if (!existsSync(screen))
      throw refuse(`\`screen\` "${screen}" does not exist`)
    result.screen = screen
  }

  const microphone = record['microphone']
  if (microphone !== undefined) {
    let file: unknown = microphone
    let startsAt: unknown
    if (typeof microphone === 'object' && microphone !== null) {
      const m = microphone as Record<string, unknown>
      file = m['file']
      startsAt = m['startsAt']
    }
    if (typeof file !== 'string' || file === '') {
      throw refuse('`microphone` has to be a file path or `{ file, startsAt }`')
    }
    if (!existsSync(file))
      throw refuse(`\`microphone\` "${file}" does not exist`)
    const mic: FakeMicrophone = { file }
    if (startsAt !== undefined) {
      const ms =
        typeof startsAt === 'number'
          ? startsAt
          : typeof startsAt === 'string'
            ? new Date(startsAt).getTime()
            : Number.NaN
      if (!Number.isFinite(ms)) {
        throw refuse(
          '`microphone.startsAt` has to be epoch milliseconds or an ISO instant',
        )
      }
      mic.startsAt = ms
    }
    result.microphone = mic
  }

  if (
    result.camera === undefined &&
    result.microphone === undefined &&
    result.screen === undefined
  ) {
    throw refuse('the object names no source at all')
  }
  return result
}

/** Where the page fetches the screen file from; answered by a route. */
export const SCREEN_PATH = '/__featurecast/screen'

/**
 * The init script that answers "share your screen" with a file.
 *
 * A string, for the reason `docs/RECORDING-SCRIPTS.md` gives under "The trap
 * that catches every injected script": a compiled function would carry
 * esbuild's `__name` into a page that has none.
 *
 * ONE ELEMENT PER CALL, not one per document. A page that shares, stops and
 * shares again gets a fresh stream each time, because stopping a track ends
 * the stream it came from and a shared element would hand back a dead one on
 * the second ask — which is exactly what a host who stops sharing and starts
 * again does.
 *
 * The element stays IN the document, parked off screen rather than
 * `display: none`: a display-none video is not guaranteed to produce frames,
 * and a share that hands over a black stream looks like a product fault.
 */
export function screenInitScript(): string {
  return `(function () {
  var md = navigator.mediaDevices;
  if (!md) return;
  md.getDisplayMedia = function () {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      video.src = ${JSON.stringify(SCREEN_PATH)};
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:720px';
      var fertig = false;
      var geben = function () {
        if (fertig) return;
        fertig = true;
        try {
          var stream = video.captureStream();
          stream.getVideoTracks().forEach(function (t) {
            t.addEventListener('ended', function () { video.remove(); });
          });
          resolve(stream);
        } catch (e) { reject(e); }
      };
      video.addEventListener('playing', geben);
      video.addEventListener('error', function () {
        reject(new Error('[featurecast] screen file could not be played'));
      });
      (document.body || document.documentElement).appendChild(video);
      var p = video.play();
      if (p && p.catch) p.catch(function (e) { reject(e); });
    });
  };
})();`
}

/**
 * Installs the file-fed screen on a context.
 *
 * Same shape as the microphone: the file is served on the page's own origin,
 * so neither CORS nor a content-security policy stands in the way, and the
 * init script reaches every document including a framed application's. Before
 * the first page, like every other context-level setting.
 */
export async function installFakeScreen(
  context: BrowserContext,
  file: string,
): Promise<void> {
  const body = await readFile(file)
  if (!/\.(mp4|m4v|webm)$/i.test(file)) {
    throw new Error(
      `The screen file has to be a video the browser can play (.mp4, .m4v or ` +
        `.webm); got "${file}".`,
    )
  }
  await context.route(`**${SCREEN_PATH}`, (route) =>
    route.fulfill({ body, contentType: contentTypeOf(file) }),
  )
  await context.addInitScript(screenInitScript())
}
