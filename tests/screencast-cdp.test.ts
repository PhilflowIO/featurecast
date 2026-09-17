import type { CDPSession, Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'

import {
  decodeScreencastFrame,
  openCdpScreencast,
} from '../src/screencast-cdp.js'

const SIZE = { height: 1600, width: 2560 }

type FramePayload = {
  data: string
  metadata: {
    deviceHeight?: number
    deviceWidth?: number
    timestamp?: number
  }
  sessionId: number
}

type Journal = Array<{ what: string; detail?: unknown }>

/**
 * A CDP session double that records the order of everything it is asked to do.
 *
 * The order is the point: several of the guarantees below are about what
 * happens *before* what, and an assertion on call counts alone would pass for
 * an implementation that has them backwards.
 */
function fakeSession(options: { ackFails?: Error } = {}): {
  detach: ReturnType<typeof vi.fn>
  emit: (payload: FramePayload) => void
  journal: Journal
  session: CDPSession
} {
  const journal: Journal = []
  let onFrame: ((payload: FramePayload) => void) | undefined
  const detach = vi.fn().mockImplementation(async () => {
    journal.push({ what: 'detach' })
  })
  const session = {
    detach,
    on(event: string, handler: (payload: FramePayload) => void) {
      if (event === 'Page.screencastFrame') onFrame = handler
    },
    async send(method: string, parameters?: unknown) {
      journal.push({ detail: parameters, what: method })
      if (method === 'Page.screencastFrameAck' && options.ackFails) {
        throw options.ackFails
      }
    },
  } as unknown as CDPSession

  return {
    detach,
    emit: (payload) => {
      if (onFrame === undefined) throw new Error('no frame handler registered')
      onFrame(payload)
    },
    journal,
    session,
  }
}

function frame(overrides: Partial<FramePayload> = {}): FramePayload {
  return {
    data: Buffer.from('a jpeg').toString('base64'),
    metadata: { deviceHeight: 1600, deviceWidth: 2560, timestamp: 1.5 },
    sessionId: 1,
    ...overrides,
  }
}

async function openWith(session: CDPSession) {
  return openCdpScreencast({} as unknown as Page, {
    openSession: () => Promise.resolve(session),
  })
}

/** Lets a `void`-returning ack rejection reach its `catch` handler. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('openCdpScreencast', () => {
  it('subscribes to frames before starting the screencast', async () => {
    // A frame that arrives while `Page.startScreencast` is still in flight has
    // to find a handler. The double delivers exactly that frame, from inside
    // the start call.
    //
    // Mutation that reddens this: send `Page.startScreencast` first and
    // register the handler afterwards - `emit` then throws 'no frame handler
    // registered', because the frame would have been delivered into nothing.
    const { emit, session } = fakeSession()
    vi.spyOn(session, 'send').mockImplementation((async (method: string) => {
      if (method === 'Page.startScreencast') emit(frame())
    }) as unknown as CDPSession['send'])
    const transport = await openWith(session)
    const onFrame = vi.fn()

    await expect(
      transport.start({ onError: vi.fn(), onFrame, quality: 90, size: SIZE }),
    ).resolves.toBeUndefined()

    expect(onFrame).toHaveBeenCalledOnce()
  })

  it('acknowledges a frame before decoding or forwarding it', async () => {
    // Mutation: move the ack to the end of the handler. The journal then reads
    // decode-then-ack, and the recorded order below fails.
    const { emit, journal, session } = fakeSession()
    const transport = await openWith(session)

    await transport.start({
      onError: vi.fn(),
      onFrame: () => {
        journal.push({ what: 'onFrame' })
      },
      quality: 90,
      size: SIZE,
    })
    journal.length = 0
    emit(frame())

    expect(journal.map((entry) => entry.what)).toEqual([
      'Page.screencastFrameAck',
      'onFrame',
    ])
  })

  it('acknowledges an unusable frame too', async () => {
    // A frame we refuse is still a frame the browser is waiting on. Mutation:
    // return from the handler before the ack when the metadata is bad - the
    // ack disappears and a real browser would stop sending after a few of
    // these.
    const { emit, journal, session } = fakeSession()
    const transport = await openWith(session)
    const onError = vi.fn()

    await transport.start({
      onError,
      onFrame: vi.fn(),
      quality: 90,
      size: SIZE,
    })
    journal.length = 0
    emit(frame({ metadata: { deviceHeight: 1600, deviceWidth: 2560 } }))

    expect(journal[0]?.what).toBe('Page.screencastFrameAck')
    expect(onError).toHaveBeenCalledOnce()
  })

  it('acknowledges with the session id the frame carried', async () => {
    // Mutation: send a constant, or a counter of our own. Chromium then never
    // clears the frame we meant to clear.
    const { emit, journal, session } = fakeSession()
    const transport = await openWith(session)

    await transport.start({
      onError: vi.fn(),
      onFrame: vi.fn(),
      quality: 90,
      size: SIZE,
    })
    journal.length = 0
    emit(frame({ sessionId: 7 }))
    emit(frame({ sessionId: 9 }))

    expect(
      journal
        .filter((entry) => entry.what === 'Page.screencastFrameAck')
        .map((entry) => entry.detail),
    ).toEqual([{ sessionId: 7 }, { sessionId: 9 }])
  })

  it('orders a jpeg screencast at even edge lengths', async () => {
    // Mutation: pass the odd width through. `yuv420p` refuses odd edges
    // downstream, and Playwright rounded here for the same reason.
    const { journal, session } = fakeSession()
    const transport = await openWith(session)

    await transport.start({
      onError: vi.fn(),
      onFrame: vi.fn(),
      quality: 77,
      size: { height: 901, width: 1281 },
    })

    expect(journal.at(-1)).toEqual({
      detail: {
        format: 'jpeg',
        maxHeight: 900,
        maxWidth: 1280,
        quality: 77,
      },
      what: 'Page.startScreencast',
    })
  })

  it('reports an acknowledgement that fails before the stop', async () => {
    // Mutation: swallow the rejection the way Playwright's `_sendMayFail`
    // does. The capture then runs to completion, quietly missing every frame
    // after the first failure.
    const { emit, session } = fakeSession({ ackFails: new Error('gone') })
    const transport = await openWith(session)
    const onError = vi.fn()

    await transport.start({
      onError,
      onFrame: vi.fn(),
      quality: 90,
      size: SIZE,
    })
    emit(frame())
    await settle()

    expect(onError).toHaveBeenCalledOnce()
    expect(String(onError.mock.calls[0]?.[0])).toContain(
      'could not be acknowledged',
    )
  })

  it('stays quiet about an acknowledgement that fails after the stop', async () => {
    // The counter-test to the one above; without it, that one would turn every
    // ordinary teardown red. Mutation: make ack failures unconditionally
    // fatal.
    const { emit, session } = fakeSession({ ackFails: new Error('gone') })
    const transport = await openWith(session)
    const onError = vi.fn()

    await transport.start({
      onError,
      onFrame: vi.fn(),
      quality: 90,
      size: SIZE,
    })
    await transport.stop()
    emit(frame())
    await settle()

    expect(onError).not.toHaveBeenCalled()
  })

  it('releases the session once, and survives a session already gone', async () => {
    // Mutation: drop the guard and `detach` runs twice; drop the try/catch and
    // a page that closed first turns teardown into a capture failure.
    const { detach, session } = fakeSession()
    const transport = await openWith(session)
    detach.mockRejectedValue(new Error('session already gone'))

    await expect(transport.detach()).resolves.toBeUndefined()
    await expect(transport.detach()).resolves.toBeUndefined()

    expect(detach).toHaveBeenCalledOnce()
  })
})

describe('decodeScreencastFrame', () => {
  it('decodes the payload byte-exactly, including a zero byte', () => {
    // Mutation: `Buffer.from(data, 'utf8')` or `'binary'`. Both survive an
    // ASCII fixture and corrupt every real JPEG, which is why the fixture here
    // is not ASCII.
    const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x7f, 0xff, 0xd9])
    const result = decodeScreencastFrame(
      frame({ data: bytes.toString('base64') }),
    )

    expect(result).not.toBeInstanceOf(Error)
    expect((result as { data: Buffer }).data).toEqual(bytes)
  })

  it('converts the capture clock from seconds to milliseconds', () => {
    // Mutation: drop the `* 1000`. Timestamps land around 1.7e9 instead of
    // 1.7e12, and every efficiency window ends up with no frames in it.
    const result = decodeScreencastFrame(
      frame({
        metadata: {
          deviceHeight: 1600,
          deviceWidth: 2560,
          timestamp: 1_700_000_000.123456,
        },
      }),
    )

    expect(result).not.toBeInstanceOf(Error)
    expect((result as { timestamp: number }).timestamp).toBeCloseTo(
      1_700_000_000_123.456,
      1,
    )
  })

  it('takes the viewport from the delivered frame, not from what was ordered', () => {
    // Mutation: fill the viewport from the start parameters. The geometry
    // check in `validateCaptureManifest` could then never fire again, which is
    // the defect it exists to catch.
    const result = decodeScreencastFrame(
      frame({
        metadata: { deviceHeight: 800, deviceWidth: 1280, timestamp: 1 },
      }),
    )

    expect(result).toMatchObject({ viewportHeight: 800, viewportWidth: 1280 })
  })

  it('refuses a frame that carries no capture clock', () => {
    // Mutation: Playwright's `Date.now()` fallback. The capture then runs
    // through and the manifest silently mixes an arrival clock into the axis
    // every efficiency number is measured against.
    const result = decodeScreencastFrame(
      frame({ metadata: { deviceHeight: 1600, deviceWidth: 2560 } }),
    )

    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('without a capture timestamp')
  })

  it('refuses a frame that carries no viewport', () => {
    // Mutation: default the dimensions to the ordered size. Same defect as
    // above, one field over.
    const result = decodeScreencastFrame(frame({ metadata: { timestamp: 1 } }))

    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('without viewport dimensions')
  })
})
