import { describe, expect, it } from 'vitest'
import { yieldToMain } from './scheduler'

describe('yieldToMain', () => {
  it('resolves in a later task, not a microtask', async () => {
    // The whole point: `await` on an already-resolved promise would resume in the same task, which
    // is exactly the long-blocking behaviour this avoids. A macrotask boundary is where the browser
    // gets to paint and handle input.
    const order: string[] = []
    const yielded = yieldToMain().then(() => order.push('yielded'))
    order.push('sync')
    await Promise.resolve()
    expect(order).toEqual(['sync'])
    await yielded
    expect(order).toEqual(['sync', 'yielded'])
  })

  it('lets queued work run between two awaits', async () => {
    const order: string[] = []
    await Promise.all([
      (async () => {
        await yieldToMain()
        order.push('after-yield')
      })(),
      Promise.resolve().then(() => order.push('microtask')),
    ])
    expect(order).toEqual(['microtask', 'after-yield'])
  })
})
