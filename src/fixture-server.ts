import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The measuring corpus, served from a real origin.
 *
 * ## Why a server at all
 *
 * A `data:` URL would be simpler and is what `demo/feature-xy.ts` uses. It
 * cannot serve here: a touch profile is recorded through the framed strategy,
 * whose shell is fulfilled at `<origin>/__featurecast_frame__` on the
 * application's *own* origin (src/framed.ts explains why that is not
 * negotiable — a foreign-origin shell takes the application's storage away).
 * A `data:` URL has an opaque origin, so there is no origin to serve a shell
 * from, and no phone or tablet can be recorded against it at all.
 *
 * ## Why it is written by hand
 *
 * `package.json` has never carried a runtime dependency (see the header of
 * src/upload.ts and src/cli.ts for the same argument about the AWS SDK and
 * about an argument parser). Serving four files out of one directory over
 * loopback is `node:http` plus a path check, which is less code than the
 * configuration of any static-file package would be.
 *
 * ## Port zero, deliberately
 *
 * The server asks the operating system for a free port instead of claiming a
 * fixed one. Two recordings in parallel — which is what a run over four
 * devices becomes the moment anyone runs two of them — would otherwise fight
 * over the same number, and the loser fails with a message about an address
 * that has nothing to do with recording.
 */

/** The corpus directory shipped with the repository. */
export const FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../fixtures/bench/', import.meta.url),
)

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * The file a request path names, or `null` when it names something outside
 * the served directory.
 *
 * The check is on the *resolved* path, not on the text of the request: a
 * request for `/../../.env` is legal to write, decodes to a legal path, and
 * only stops being harmless once it has been resolved against the root. The
 * corpus is public material, but the server sits on a machine where the
 * repository is not, and a fixture server that reads a neighbour's files is
 * a fixture server that will eventually be pointed at one.
 */
export function resolveFixturePath(
  root: string,
  requestPath: string,
): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0] ?? '/')
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const relative = decoded === '/' || decoded === '' ? '/index.html' : decoded
  const rootPath = resolve(root)
  const target = resolve(join(rootPath, relative))
  if (target !== rootPath && !target.startsWith(rootPath + sep)) return null
  return target
}

export type FixtureServer = {
  /** Stops accepting connections and resolves once the socket is closed. */
  close: () => Promise<void>
  /** `http://127.0.0.1:<port>` — the corpus's origin for this run. */
  origin: string
}

/**
 * Starts the corpus server on a free loopback port.
 *
 * The handle is `unref`'d: a recording script that exports its origin at
 * module scope has nowhere natural to close it, and an open listener would
 * keep the process alive after the last video was written. Live connections
 * hold the process open on their own, so nothing in flight is cut short.
 */
export async function startFixtureServer(
  options: { directory?: string; host?: string } = {},
): Promise<FixtureServer> {
  const directory = resolve(options.directory ?? FIXTURE_DIRECTORY)
  const host = options.host ?? '127.0.0.1'
  const server: Server = createServer((request, response) => {
    const path = resolveFixturePath(directory, request.url ?? '/')
    if (path === null) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('forbidden\n')
      return
    }
    readFile(path).then(
      (bytes) => {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': contentTypeFor(path),
          // The same header the applications this corpus stands in for send.
          // The framed strategy satisfies it by serving its shell from this
          // origin; a fixture that omitted it would let a wrong shell pass.
          'x-frame-options': 'SAMEORIGIN',
        })
        response.end(bytes)
      },
      () => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found\n')
      },
    )
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error(
      'startFixtureServer: the listener reported no TCP port; the corpus has no origin to serve from.',
    )
  }
  server.unref()

  return {
    close: async () =>
      new Promise<void>((resolvePromise, reject) => {
        // Keep-alive sockets outlive the last response, and `close` waits for
        // every one of them; without this a caller that closed the browser
        // first still waits out the idle timeout.
        server.closeAllConnections()
        server.close((error) => {
          if (error) reject(error)
          else resolvePromise()
        })
      }),
    origin: `http://${host}:${String(address.port)}`,
  }
}
