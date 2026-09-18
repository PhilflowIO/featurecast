import { chromium, type Browser, type BrowserType } from 'playwright'
import { fileURLToPath } from 'node:url'

import { BUNDLE_CHANNEL } from '../src/browser.js'

type HelloBrowser = Pick<Browser, 'close' | 'newPage'>
type HelloChromium = Pick<BrowserType<HelloBrowser>, 'launch'>

export async function openHelloPage(
  browserType: HelloChromium = chromium,
): Promise<void> {
  const browser = await browserType.launch({
    channel: BUNDLE_CHANNEL,
    headless: true,
  })

  try {
    const page = await browser.newPage()
    await page.goto('data:text/html,<h1>Featurecast</h1>')
  } finally {
    await browser.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await openHelloPage()
}
