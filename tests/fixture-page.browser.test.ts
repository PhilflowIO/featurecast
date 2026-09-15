import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  startFixtureServer,
  type FixtureServer,
} from '../src/fixture-server.js'

/**
 * What the corpus has to be, measured in a real browser rather than asserted
 * from its source.
 *
 * The three properties below are the whole reason it exists, and each of them
 * is a property of the *laid-out* page: how far it scrolls sideways, that one
 * scroll container sits inside another, and that the same controls are on
 * screen at a phone's width as at a desktop's. A fixture that lost any of
 * them would still look right in the file and would quietly stop measuring
 * anything.
 */

/** A phone's layout width, the width the framed strategy lays the app out at. */
const PHONE = { height: 852, width: 393 }
const DESKTOP = { height: 1080, width: 1920 }

type Geometry = {
  gridRangeX: number
  gridRangeY: number
  gridVisibleWidth: number
  gridTotalWidth: number
  pageRangeY: number
  nested: boolean
}

describe('the bench corpus', () => {
  let browser: Browser
  let server: FixtureServer

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    server = await startFixtureServer()
  })

  afterAll(async () => {
    await browser.close()
    await server.close()
  })

  async function measure(viewport: {
    height: number
    width: number
  }): Promise<Geometry> {
    const context = await browser.newContext({ viewport })
    try {
      const page = await context.newPage()
      await page.goto(`${server.origin}/#/collections/tasks`, {
        waitUntil: 'load',
      })
      await page.getByRole('grid').waitFor()
      return (await page.evaluate(`
        (function () {
          var grid = document.getElementById('gridscroller');
          var main = document.getElementById('page');
          return {
            gridRangeX: grid.scrollWidth - grid.clientWidth,
            gridRangeY: grid.scrollHeight - grid.clientHeight,
            gridVisibleWidth: grid.clientWidth,
            gridTotalWidth: grid.scrollWidth,
            pageRangeY: main.scrollHeight - main.clientHeight,
            nested: main.contains(grid)
              && getComputedStyle(main).overflowY === 'auto'
              && getComputedStyle(grid).overflowX === 'auto'
          };
        })()
      `)) as Geometry
    } finally {
      await context.close()
    }
  }

  it('scrolls sideways over a long distance at a desktop width', async () => {
    const geometry = await measure(DESKTOP)

    // The historical finding this corpus replaces was about *horizontal*
    // scrolling, so this is the number that has to be large. A grid that
    // merely peeks past the fold would leave nothing to measure.
    expect(geometry.gridRangeX).toBeGreaterThan(2_000)
    expect(geometry.gridTotalWidth).toBeGreaterThan(
      geometry.gridVisibleWidth * 2,
    )
    expect(geometry.gridRangeY).toBeGreaterThan(400)
  })

  it('scrolls sideways even further at a phone width', async () => {
    const geometry = await measure(PHONE)

    expect(geometry.gridRangeX).toBeGreaterThan(3_500)
    expect(geometry.gridTotalWidth).toBeGreaterThan(
      geometry.gridVisibleWidth * 8,
    )
    expect(geometry.gridRangeY).toBeGreaterThan(700)
  })

  it('puts one scroll container inside another at both widths', async () => {
    // `src/wheel-target.ts` chooses where a wheel is delivered precisely
    // because a nested scroller swallows one aimed at the middle. Without
    // this shape, that whole decision has no subject.
    for (const viewport of [DESKTOP, PHONE]) {
      const geometry = await measure(viewport)
      expect(geometry.nested).toBe(true)
      expect(geometry.pageRangeY).toBeGreaterThan(200)
    }
  })

  it('offers the same controls at a phone width as at a desktop width', async () => {
    for (const viewport of [DESKTOP, PHONE]) {
      const context = await browser.newContext({ viewport })
      try {
        const page = await context.newPage()
        await page.goto(server.origin, { waitUntil: 'load' })
        // No menu button, no drawer, no width-only control: this is what lets
        // one recording script serve a desktop, a tablet and two phones.
        await page
          .getByRole('button', { name: 'Switch to dark mode' })
          .waitFor({ state: 'visible' })
        await page
          .getByRole('searchbox', { name: 'Search records' })
          .waitFor({ state: 'visible' })
        for (const title of ['tasks', 'invoices', 'users', 'expenses']) {
          const box = await page
            .locator(`nav a[title="${title}"]`)
            .boundingBox()
          expect(box).not.toBeNull()
          expect(box?.width ?? 0).toBeGreaterThan(0)
        }
        expect(await page.getByRole('button', { name: /menu/i }).count()).toBe(
          0,
        )
      } finally {
        await context.close()
      }
    }
  })

  it('holds enough records in every collection to be worth filming', async () => {
    const context = await browser.newContext({ viewport: DESKTOP })
    try {
      const page = await context.newPage()
      for (const collection of ['tasks', 'invoices', 'users', 'expenses']) {
        await page.goto(`${server.origin}/#/collections/${collection}`, {
          waitUntil: 'load',
        })
        await page.getByRole('grid').waitFor()
        const records = await page.evaluate(`
          (function () {
            var heading = document.querySelector('main h1');
            var text = heading.parentElement.textContent || '';
            var match = /(\\d+)\\s*records?/.exec(text);
            return match ? Number(match[1]) : -1;
          })()
        `)
        expect(records).toBeGreaterThanOrEqual(10)
        expect(await page.getByRole('row').count()).toBeGreaterThan(10)
      }
    } finally {
      await context.close()
    }
  })
})
