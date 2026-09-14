import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildObjectUrl,
  contentTypeForFile,
  encodePathSegment,
  resolveUploadConfig,
  signPutObject,
  uploadFile,
  UPLOAD_ENV_VARIABLES,
  type UploadConfig,
  type UploadHttpRequest,
  type UploadTransport,
} from '../src/upload.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-upload-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/**
 * Credentials for a store that does not exist. `example.invalid` is reserved
 * by RFC 2606 and can never resolve, so even a bug that bypassed the injected
 * transport could not reach a real host. The secret is a literal string typed
 * here, not a redacted real one.
 */
const testConfig: UploadConfig = {
  accessKeyId: 'AKIAFEATURECASTTEST',
  bucket: 'featurecast-demo',
  endpoint: 'https://garage.example.invalid',
  region: 'eu-central-1',
  secretAccessKey: 'wJalrXUtnFEMI-NOT-A-REAL-SECRET-0000000',
}

const fullEnvironment: Record<string, string> = {
  [UPLOAD_ENV_VARIABLES.accessKeyId]: testConfig.accessKeyId,
  [UPLOAD_ENV_VARIABLES.bucket]: testConfig.bucket,
  [UPLOAD_ENV_VARIABLES.endpoint]: testConfig.endpoint,
  [UPLOAD_ENV_VARIABLES.region]: testConfig.region,
  [UPLOAD_ENV_VARIABLES.secretAccessKey]: testConfig.secretAccessKey,
}

function recordingTransport(status = 200): {
  requests: UploadHttpRequest[]
  transport: UploadTransport
} {
  const requests: UploadHttpRequest[] = []
  return {
    requests,
    transport: (request) => {
      requests.push(request)
      return Promise.resolve({ body: '', status })
    },
  }
}

describe('resolveUploadConfig', () => {
  it('names every missing variable, not just the first one', () => {
    expect(() =>
      resolveUploadConfig({
        [UPLOAD_ENV_VARIABLES.endpoint]: testConfig.endpoint,
        [UPLOAD_ENV_VARIABLES.region]: testConfig.region,
      }),
    ).toThrow(
      /FEATURECAST_S3_BUCKET, FEATURECAST_S3_ACCESS_KEY_ID, FEATURECAST_S3_SECRET_ACCESS_KEY are missing or empty/,
    )
  })

  it('treats a set-but-blank variable as missing', () => {
    // A blank secret produces a well-formed signature that the store rejects
    // with a 403 saying nothing about where the fault is. Failing here names
    // the variable instead.
    expect(() =>
      resolveUploadConfig({
        ...fullEnvironment,
        [UPLOAD_ENV_VARIABLES.secretAccessKey]: '   ',
      }),
    ).toThrow(/FEATURECAST_S3_SECRET_ACCESS_KEY is missing or empty/)
  })

  it('never echoes a credential value in the failure message', () => {
    let message = ''
    try {
      resolveUploadConfig({
        ...fullEnvironment,
        [UPLOAD_ENV_VARIABLES.bucket]: '',
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain(testConfig.secretAccessKey)
    expect(message).not.toContain(testConfig.accessKeyId)
  })

  it('reads a complete environment and leaves the optional base URL unset', () => {
    expect(resolveUploadConfig(fullEnvironment)).toEqual(testConfig)
  })

  it('carries the optional public base URL through when it is set', () => {
    expect(
      resolveUploadConfig({
        ...fullEnvironment,
        [UPLOAD_ENV_VARIABLES.publicBaseUrl]: 'https://cdn.example.invalid/v',
      }).publicBaseUrl,
    ).toBe('https://cdn.example.invalid/v')
  })
})

describe('signPutObject', () => {
  /**
   * The outer anchor for the whole signer. This Authorization header was not
   * produced by the code under test: it comes from botocore 1.42.73's own
   * `SigV4Auth` (an independent implementation of the same published
   * algorithm), signing the same PUT of the same body to the same URL with
   * `get_current_datetime` frozen to 2026-01-02T03:04:05Z. If this file's
   * canonicalization, header ordering, key derivation, or path encoding
   * drifts by one byte, the HMAC chain diverges completely and this string
   * stops matching — which is the only way to notice a signing bug without a
   * live store to be rejected by.
   */
  it('matches botocore SigV4 byte for byte', () => {
    const signed = signPutObject(
      testConfig,
      'recordings/demo feature.mp4',
      new TextEncoder().encode('featurecast-test-payload'),
      'video/mp4',
      new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    )
    expect(signed.headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAFEATURECASTTEST/20260102/eu-central-1/s3/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f84ab3186f4817274486fd2196c13240bc2dd8ebfe91a57cbcd8c1f7d20cc5fa',
    )
  })

  it('addresses the bucket path-style and percent-encodes the key', () => {
    // Virtual-host style would need a wildcard DNS record per deployment; a
    // plain Garage install serves path-style. The space in the key has to be
    // encoded identically in the URL and in the canonical request, or the
    // store recomputes a different signature.
    const signed = signPutObject(
      testConfig,
      'recordings/demo feature.mp4',
      new Uint8Array(),
      'video/mp4',
      new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    )
    expect(signed.url).toBe(
      'https://garage.example.invalid/featurecast-demo/recordings/demo%20feature.mp4',
    )
    expect(signed.canonical.split('\n')[1]).toBe(
      '/featurecast-demo/recordings/demo%20feature.mp4',
    )
  })

  it('signs the payload hash rather than an unsigned-payload placeholder', () => {
    const body = new TextEncoder().encode('featurecast-test-payload')
    const signed = signPutObject(
      testConfig,
      'clip.mp4',
      body,
      'video/mp4',
      new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    )
    expect(signed.headers['x-amz-content-sha256']).toBe(
      '4349ccf0e1b6cffb287c05ac2f94b6f1b2dec8eb5bf6e31c0249d5ab78228aac',
    )
    expect(signed.headers['content-length']).toBe(String(body.byteLength))
  })

  it('changes the signature when the body changes', () => {
    const sign = (body: string): string | undefined =>
      signPutObject(
        testConfig,
        'clip.mp4',
        new TextEncoder().encode(body),
        'video/mp4',
        new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
      ).headers['authorization']
    expect(sign('one')).not.toBe(sign('two'))
  })
})

describe('encodePathSegment', () => {
  it('encodes the sub-delimiters encodeURIComponent leaves alone', () => {
    // RFC 3986's unreserved set is A-Za-z0-9-_.~ and SigV4 wants everything
    // else encoded; encodeURIComponent passes !'()* through untouched.
    expect(encodePathSegment("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af')
    expect(encodePathSegment('keep-_.~')).toBe('keep-_.~')
  })
})

describe('buildObjectUrl', () => {
  it('falls back to endpoint and bucket when no public base URL is set', () => {
    expect(buildObjectUrl(testConfig, 'recordings/clip.mp4')).toBe(
      'https://garage.example.invalid/featurecast-demo/recordings/clip.mp4',
    )
  })

  it('prefers the public base URL and does not double the slash', () => {
    expect(
      buildObjectUrl(
        { ...testConfig, publicBaseUrl: 'https://cdn.example.invalid/v/' },
        'clip.mp4',
      ),
    ).toBe('https://cdn.example.invalid/v/clip.mp4')
  })
})

describe('contentTypeForFile', () => {
  it('labels the formats this pipeline produces', () => {
    expect(contentTypeForFile('/out/clip.MP4')).toBe('video/mp4')
    expect(contentTypeForFile('/out/events.jsonl')).toBe('application/x-ndjson')
    expect(contentTypeForFile('/out/thing.unknown')).toBe(
      'application/octet-stream',
    )
  })
})

describe('uploadFile', () => {
  it('PUTs the file bytes through the injected transport and returns its URL', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, 'video-bytes')
    const { requests, transport } = recordingTransport()

    const url = await uploadFile(file, { config: testConfig, transport })

    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request?.method).toBe('PUT')
    expect(request?.url).toBe(
      'https://garage.example.invalid/featurecast-demo/clip.mp4',
    )
    expect(
      Buffer.from(request?.body ?? new Uint8Array()).toString('utf8'),
    ).toBe('video-bytes')
    expect(request?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(request?.headers['content-type']).toBe('video/mp4')
    expect(url).toBe('https://garage.example.invalid/featurecast-demo/clip.mp4')
  })

  it('uploads under an explicit key when one is given', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, 'video-bytes')
    const { requests, transport } = recordingTransport()

    const url = await uploadFile(file, {
      config: testConfig,
      key: 'demos/feature-xy/desktop.mp4',
      transport,
    })

    expect(requests[0]?.url).toBe(
      'https://garage.example.invalid/featurecast-demo/demos/feature-xy/desktop.mp4',
    )
    expect(url).toBe(
      'https://garage.example.invalid/featurecast-demo/demos/feature-xy/desktop.mp4',
    )
  })

  it('reports the store status instead of returning an unreachable URL', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, 'video-bytes')

    await expect(
      uploadFile(file, {
        config: testConfig,
        transport: () =>
          Promise.resolve({
            body: '<Error><Code>AccessDenied</Code></Error>',
            status: 403,
          }),
      }),
    ).rejects.toThrow(/failed with HTTP 403.*AccessDenied/s)
  })
})
