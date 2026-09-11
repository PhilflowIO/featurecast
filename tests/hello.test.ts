import { describe, expect, it, vi } from 'vitest'

import { openHelloPage } from '../demo/hello.js'

describe('openHelloPage', () => {
  it('opens a page and closes the browser', async () => {
    const goto = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const browser = {
      close,
      newPage: vi.fn().mockResolvedValue({ goto }),
    }
    const chromium = {
      launch: vi.fn().mockResolvedValue(browser),
    }

    await openHelloPage(chromium)

    expect(chromium.launch).toHaveBeenCalledWith({ headless: true })
    expect(browser.newPage).toHaveBeenCalledOnce()
    expect(goto).toHaveBeenCalledWith('data:text/html,<h1>Featurecast</h1>')
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the browser when navigation fails', async () => {
    const goto = vi.fn().mockRejectedValue(new Error('navigation failed'))
    const close = vi.fn().mockResolvedValue(undefined)
    const browser = {
      close,
      newPage: vi.fn().mockResolvedValue({ goto }),
    }
    const chromium = {
      launch: vi.fn().mockResolvedValue(browser),
    }

    await expect(openHelloPage(chromium)).rejects.toThrow('navigation failed')

    expect(close).toHaveBeenCalledOnce()
  })
})
