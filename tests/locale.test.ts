import { describe, expect, it } from 'vitest'

import {
  localeLaunchEnvironment,
  readLocale,
  readTimezone,
} from '../src/locale.js'
import { readContextSettings } from '../src/pipeline.js'
import { contextOptionsFor } from '../src/session.js'

describe('readLocale (featurecast#172)', () => {
  it('canonicalizes a tag with a region', () => {
    expect(readLocale('de-DE')).toBe('de-DE')
    expect(readLocale('de-de')).toBe('de-DE')
  })

  it('refuses a tag without a region instead of guessing one', () => {
    expect(() => readLocale('de')).toThrow(/without a region/)
  })

  it('refuses what is not a tag', () => {
    expect(() => readLocale('')).toThrow(/language tag/)
    expect(() => readLocale(42)).toThrow(/language tag/)
    expect(() => readLocale('de_DE')).toThrow(/not a language tag/)
  })

  it('is read as a context setting of a script', () => {
    expect(readContextSettings({ locale: 'de-DE' }, 'demo/x.ts')).toEqual({
      locale: 'de-DE',
    })
    expect(() => readContextSettings({ locale: 'de' }, 'demo/x.ts')).toThrow(
      /"demo\/x.ts" exports `locale`/,
    )
  })
})

describe('localeLaunchEnvironment', () => {
  it('names the locale in LANG and LANGUAGE, keeping the rest', () => {
    const environment = localeLaunchEnvironment('de-DE', {
      HOME: '/tmp',
      LANG: 'C.UTF-8',
    })
    expect(environment).toEqual({
      HOME: '/tmp',
      LANG: 'de_DE.UTF-8',
      LANGUAGE: 'de_DE:de',
    })
  })

  it('drops LC_ALL and LC_MESSAGES, which would outrank LANG', () => {
    const environment = localeLaunchEnvironment('de-AT', {
      LC_ALL: 'en_US.UTF-8',
      LC_MESSAGES: 'en_US.UTF-8',
    })
    expect(environment).toEqual({ LANG: 'de_AT.UTF-8', LANGUAGE: 'de_AT:de' })
  })
})

describe('readTimezone', () => {
  it('accepts an IANA name', () => {
    expect(readTimezone('Europe/Berlin')).toBe('Europe/Berlin')
  })

  it('names the export when the value is not a string', () => {
    expect(() => readTimezone(2, 'demo/x.ts')).toThrow(/demo\/x\.ts.*timezone/s)
  })

  it('rejects a name the browser would also reject', () => {
    expect(() => readTimezone('Europe/Atlantis')).toThrow(/not an IANA/)
  })
})

describe('timezone reaches the recording context', () => {
  it('is read off the script module like locale is', () => {
    expect(
      readContextSettings({ locale: 'de-DE', timezone: 'Europe/Berlin' }),
    ).toMatchObject({ locale: 'de-DE', timezone: 'Europe/Berlin' })
  })

  it('becomes the context option Playwright understands', () => {
    const options = contextOptionsFor(
      {
        capture: { strategy: 'screencast' },
        device: {},
      } as never,
      { height: 800, width: 1200 },
      undefined,
      false,
      'de-DE',
      'Europe/Berlin',
    )
    expect(options.timezoneId).toBe('Europe/Berlin')
  })
})
