import { connect } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  contentTypeFor,
  resolveFixturePath,
  startFixtureServer,
  FIXTURE_DIRECTORY,
} from '../src/fixture-server.js'

const ROOT = '/srv/corpus'

/** Sends one hand-written request line and reports the status code. */
async function requestLine(origin: string, path: string): Promise<number> {
  const { port } = new URL(origin)
  return new Promise<number>((resolvePromise, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(port) }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
    })
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8')
      const match = /^HTTP\/1\.1 (\d{3})/.exec(text)
      if (match) {
        socket.destroy()
        resolvePromise(Number(match[1]))
      }
    })
    socket.on('error', reject)
  })
}

describe('resolveFixturePath', () => {
  it('serves the index for the root path', () => {
    expect(resolveFixturePath(ROOT, '/')).toBe('/srv/corpus/index.html')
  })

  it('drops a query string before looking for a file', () => {
    expect(resolveFixturePath(ROOT, '/bench.css?v=2')).toBe(
      '/srv/corpus/bench.css',
    )
  })

  it('refuses a path that climbs out of the served directory', () => {
    expect(resolveFixturePath(ROOT, '/../../package.json')).toBeNull()
  })

  it('refuses a climb that is hidden behind percent-encoding', () => {
    // The text of this request contains no `..` at all; only the resolved
    // path does, which is why the check is on the resolved path.
    expect(resolveFixturePath(ROOT, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
  })

  it('refuses a path that is not decodable at all', () => {
    expect(resolveFixturePath(ROOT, '/%')).toBeNull()
  })

  it('refuses a path carrying a null byte', () => {
    expect(resolveFixturePath(ROOT, '/bench.css%00.png')).toBeNull()
  })

  it('accepts a neighbour directory whose name merely starts like the root', () => {
    // Reachability for the check above: a prefix comparison without the
    // separator would call `/srv/corpus-private` an inside path.
    expect(resolveFixturePath(ROOT, '/nested/page.html')).toBe(
      '/srv/corpus/nested/page.html',
    )
    expect(resolveFixturePath('/srv/corpus', '/../corpus-private/x')).toBeNull()
  })
})

describe('contentTypeFor', () => {
  it('names the types the corpus actually ships', () => {
    expect(contentTypeFor('/a/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/a/bench.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/a/bench.js')).toBe('text/javascript; charset=utf-8')
  })

  it('falls back rather than guessing for anything else', () => {
    expect(contentTypeFor('/a/notes')).toBe('application/octet-stream')
  })
})

describe('startFixtureServer', () => {
  it('serves the corpus from a real origin on a port it was given', async () => {
    const server = await startFixtureServer()
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const response = await fetch(`${server.origin}/`)
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      // The header the framed strategy has to satisfy rather than strip.
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(html).toContain('Search records')
      expect(html).toContain('bench.js')
    } finally {
      await server.close()
    }
  })

  it('takes a free port per run, so two recordings never collide', async () => {
    const first = await startFixtureServer()
    const second = await startFixtureServer()
    try {
      expect(first.origin).not.toBe(second.origin)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('answers 404 for a file the corpus does not have', async () => {
    const server = await startFixtureServer()
    try {
      const response = await fetch(`${server.origin}/nothing-here.js`)
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('answers 403 rather than reading a file outside the corpus', async () => {
    // A raw socket, not `fetch`: Node's client resolves `..` out of a URL
    // before it sends it, so a request written with `fetch` can never carry
    // the path this is about and the assertion would pass without the server
    // ever refusing anything.
    const server = await startFixtureServer()
    try {
      const status = await requestLine(server.origin, '/../package.json')
      expect(status).toBe(403)
      expect(await requestLine(server.origin, '/index.html')).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('stops answering once it is closed', async () => {
    const server = await startFixtureServer()
    const origin = server.origin
    expect((await fetch(`${origin}/`)).status).toBe(200)

    await server.close()

    await expect(fetch(`${origin}/`)).rejects.toThrow()
  })

  it('points at the corpus that ships with the repository by default', () => {
    expect(FIXTURE_DIRECTORY).toMatch(/fixtures[/\\]bench[/\\]?$/)
  })
})
