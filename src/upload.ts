import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

/**
 * Uploads a finished recording into the S3-compatible object store (Garage)
 * and returns a URL the file can be fetched from.
 *
 * ## Why this signs requests itself instead of depending on `@aws-sdk/client-s3`
 *
 * What this stage has to do is one HTTP request: `PUT` one object into one
 * bucket, with one `Authorization: AWS4-HMAC-SHA256 ...` header. The signing
 * procedure for that header is a fixed, published algorithm over `node:crypto`
 * primitives — it is roughly the `canonicalRequest`/`stringToSign`/
 * `signingKey` trio below, and it does not change.
 *
 * `@aws-sdk/client-s3` would be the first *runtime* dependency this package
 * has ever had (`package.json` currently declares `devDependencies` only), and
 * it arrives with a three-figure transitive package count, its own middleware
 * stack, its own credential-provider chain, and its own release cadence — all
 * of it in service of an API surface (multipart, presigning, lifecycle,
 * bucket administration, the full credential chain) this stage does not use
 * and, per the requirement that credentials come from the environment and
 * nowhere else, must not use. In six months the thing a maintainer has to
 * understand here is "which bytes get hashed, in which order"; that question
 * is answered by reading this file, and it is answered by reading an
 * SDK-based version only after descending through the middleware stack. The
 * lean dependency tree is not an aesthetic preference in this repo, it is
 * what makes `pnpm install` on a fresh machine cheap.
 *
 * The rejected alternative — taking `@aws-sdk/client-s3` — is the right call
 * the moment this stage needs something the SDK does well and a hand-written
 * signer does badly: multipart upload for objects past the 5 GiB single-PUT
 * ceiling, retry/backoff policy against a flaky endpoint, or assumed-role
 * credentials. Featurecast outputs are single videos of tens of megabytes
 * from a machine that also produced them, so none of those apply today. The
 * swap stays cheap because callers only ever see `uploadFile`.
 *
 * ## Addressing
 *
 * Requests are path-style (`<endpoint>/<bucket>/<key>`) rather than
 * virtual-host style (`<bucket>.<endpoint>/<key>`). Virtual-host style needs
 * a wildcard DNS record per Garage deployment; path-style needs nothing and
 * is what a plain Garage install serves.
 */

/** Environment variables this module reads. Nothing else configures it. */
export const UPLOAD_ENV_VARIABLES = {
  accessKeyId: 'FEATURECAST_S3_ACCESS_KEY_ID',
  bucket: 'FEATURECAST_S3_BUCKET',
  endpoint: 'FEATURECAST_S3_ENDPOINT',
  publicBaseUrl: 'FEATURECAST_S3_PUBLIC_BASE_URL',
  region: 'FEATURECAST_S3_REGION',
  secretAccessKey: 'FEATURECAST_S3_SECRET_ACCESS_KEY',
} as const

/** The variables without which no upload can be attempted. */
const REQUIRED_ENV_VARIABLES = [
  UPLOAD_ENV_VARIABLES.endpoint,
  UPLOAD_ENV_VARIABLES.region,
  UPLOAD_ENV_VARIABLES.bucket,
  UPLOAD_ENV_VARIABLES.accessKeyId,
  UPLOAD_ENV_VARIABLES.secretAccessKey,
] as const

const SERVICE = 's3'
const ALGORITHM = 'AWS4-HMAC-SHA256'

export type UploadConfig = {
  accessKeyId: string
  bucket: string
  endpoint: string
  /** Base URL handed back to callers, for a bucket published under a CDN or
   * a reverse proxy. Falls back to `<endpoint>/<bucket>`. */
  publicBaseUrl?: string
  region: string
  secretAccessKey: string
}

export type UploadHttpRequest = {
  body: Uint8Array
  headers: Readonly<Record<string, string>>
  method: 'PUT'
  url: string
}

export type UploadHttpResponse = {
  body: string
  status: number
}

/**
 * The single seam between this module and the network. Tests inject a
 * recording stub; production injects `fetchTransport`. Nothing else in this
 * file touches a socket, so the whole signing and URL path is provable
 * without a store to talk to.
 */
export type UploadTransport = (
  request: UploadHttpRequest,
) => Promise<UploadHttpResponse>

export type UploadOptions = {
  config?: UploadConfig
  contentType?: string
  /** Object key inside the bucket. Defaults to the file's own name. */
  key?: string
  /** Signing time. Injectable so a signature can be pinned in a test. */
  now?: Date
  transport?: UploadTransport
}

/**
 * Reads the upload configuration out of an environment map.
 *
 * A variable that is set but blank counts as missing: an empty
 * `FEATURECAST_S3_SECRET_ACCESS_KEY` would otherwise produce a
 * well-formed-but-wrong signature and a remote 403 that says nothing about
 * where the fault is. The thrown message names every missing variable at
 * once rather than the first one, so a fresh machine is configured in one
 * pass instead of five failed runs. It never echoes a value.
 */
export function resolveUploadConfig(
  environment: Readonly<Record<string, string | undefined>>,
): UploadConfig {
  const missing = REQUIRED_ENV_VARIABLES.filter(
    (name) => (environment[name] ?? '').trim() === '',
  )
  if (missing.length > 0) {
    throw new Error(
      `Upload is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing or empty. Set ${
        missing.length === 1 ? 'it' : 'them'
      } in the environment; featurecast never reads credentials from the repository.`,
    )
  }
  const read = (name: string): string => (environment[name] ?? '').trim()
  const publicBaseUrl = read(UPLOAD_ENV_VARIABLES.publicBaseUrl)
  return {
    accessKeyId: read(UPLOAD_ENV_VARIABLES.accessKeyId),
    bucket: read(UPLOAD_ENV_VARIABLES.bucket),
    endpoint: read(UPLOAD_ENV_VARIABLES.endpoint),
    region: read(UPLOAD_ENV_VARIABLES.region),
    secretAccessKey: read(UPLOAD_ENV_VARIABLES.secretAccessKey),
    ...(publicBaseUrl === '' ? {} : { publicBaseUrl }),
  }
}

/**
 * Percent-encodes one path segment the way SigV4 canonicalization requires:
 * every byte outside the RFC 3986 unreserved set is encoded, including the
 * ones `encodeURIComponent` leaves alone (`!'()*`). `/` never reaches this
 * function — it separates segments and stays literal in the canonical URI.
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

function encodeObjectKey(key: string): string {
  return key.split('/').map(encodePathSegment).join('/')
}

function sha256Hex(payload: Uint8Array | string): string {
  return createHash('sha256').update(payload).digest('hex')
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** `20260102T030405Z` / `20260102`, the two time formats SigV4 wants. */
export function formatAmzDate(date: Date): {
  amzDate: string
  dateStamp: string
} {
  const amzDate = `${date.toISOString().replaceAll(/[:-]|\.\d{3}/g, '')}`
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/**
 * The canonical request: the exact byte string whose hash goes into the
 * string-to-sign. Header names are lowercased and sorted, header values have
 * their surrounding whitespace stripped, and the (empty) query string and
 * payload hash close it out.
 */
export function canonicalRequest(
  method: string,
  canonicalUri: string,
  headers: Readonly<Record<string, string>>,
  payloadHash: string,
): { canonical: string; signedHeaders: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const signedHeaders = entries.map(([name]) => name).join(';')
  const canonicalHeaders = entries
    .map(([name, value]) => `${name}:${value}\n`)
    .join('')
  return {
    canonical: [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n'),
    signedHeaders,
  }
}

/** `AWS4-HMAC-SHA256\n<amzDate>\n<scope>\n<sha256(canonicalRequest)>`. */
export function stringToSign(
  amzDate: string,
  credentialScope: string,
  canonical: string,
): string {
  return [ALGORITHM, amzDate, credentialScope, sha256Hex(canonical)].join('\n')
}

/** The four chained HMACs that turn the secret into a date/region/service key. */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), SERVICE),
    'aws4_request',
  )
}

export type SignedRequest = {
  canonical: string
  headers: Record<string, string>
  url: string
}

/**
 * Signs a `PUT` of `body` to `key` and returns the request as it goes on the
 * wire. Kept separate from `uploadFile` so the signature is a pure function
 * of its inputs and can be pinned against an independent implementation.
 */
export function signPutObject(
  config: UploadConfig,
  key: string,
  body: Uint8Array,
  contentType: string,
  now: Date,
): SignedRequest {
  const endpoint = new URL(config.endpoint)
  const { amzDate, dateStamp } = formatAmzDate(now)
  const payloadHash = sha256Hex(body)
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, '')}/${encodePathSegment(config.bucket)}/${encodeObjectKey(key)}`
  const headers: Record<string, string> = {
    'content-type': contentType,
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const { canonical, signedHeaders } = canonicalRequest(
    'PUT',
    canonicalUri,
    headers,
    payloadHash,
  )
  const credentialScope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`
  const signature = hmac(
    signingKey(config.secretAccessKey, dateStamp, config.region),
    stringToSign(amzDate, credentialScope, canonical),
  ).toString('hex')
  return {
    canonical,
    headers: {
      ...headers,
      authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-length': String(body.byteLength),
    },
    url: `${endpoint.origin}${canonicalUri}`,
  }
}

/**
 * The URL a caller can hand to someone else. `publicBaseUrl` exists because
 * the endpoint the signature is computed against is frequently *not* the
 * address the object is served from — a Garage node behind a reverse proxy or
 * a CDN is the normal case, and signing against the public name would then
 * fail on host mismatch.
 */
export function buildObjectUrl(config: UploadConfig, key: string): string {
  const base =
    config.publicBaseUrl === undefined
      ? `${config.endpoint.replace(/\/+$/, '')}/${encodePathSegment(config.bucket)}`
      : config.publicBaseUrl.replace(/\/+$/, '')
  return `${base}/${encodeObjectKey(key)}`
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.webm': 'video/webm',
}

export function contentTypeForFile(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  )
}

/** The production transport. The only place in this module that opens a socket. */
export const fetchTransport: UploadTransport = async (request) => {
  const response = await fetch(request.url, {
    // `BodyInit` in @types/node only admits `Uint8Array<ArrayBuffer>`, while
    // `readFile` hands back `Buffer<ArrayBufferLike>`. undici accepts any
    // ArrayBufferView at runtime; copying a whole video into a fresh
    // ArrayBuffer only to satisfy the narrower type would double peak memory
    // for no behavioral gain.
    body: request.body as Uint8Array<ArrayBuffer>,
    headers: { ...request.headers },
    method: request.method,
  })
  return { body: await response.text(), status: response.status }
}

/**
 * Uploads a local file and returns the URL it can be fetched from.
 *
 * The file is read into memory before it is signed, because SigV4 needs the
 * payload hash *before* the first byte goes out and a second streaming pass
 * would buy nothing here: featurecast's outputs are single videos of tens of
 * megabytes produced by the same machine that is now uploading them. An
 * object large enough for that to hurt is also an object that needs multipart
 * upload, which is the point at which this module's dependency decision gets
 * revisited (see the file header) rather than the point at which it grows a
 * streaming hasher.
 */
export async function uploadFile(
  localPath: string,
  options: UploadOptions = {},
): Promise<string> {
  const config = options.config ?? resolveUploadConfig(process.env)
  const key = options.key ?? basename(localPath)
  const body = await readFile(localPath)
  const request = signPutObject(
    config,
    key,
    body,
    options.contentType ?? contentTypeForFile(localPath),
    options.now ?? new Date(),
  )
  const transport = options.transport ?? fetchTransport
  const response = await transport({
    body,
    headers: request.headers,
    method: 'PUT',
    url: request.url,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Upload of "${key}" to bucket "${config.bucket}" failed with HTTP ${String(response.status)}: ${response.body.slice(0, 200)}`,
    )
  }
  return buildObjectUrl(config, key)
}
