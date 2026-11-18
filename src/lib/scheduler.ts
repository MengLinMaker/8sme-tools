/**
 * Yield to the main thread.
 *
 * A long `for (… await work())` loop over cheap, *synchronous* steps (text edits, check re-runs,
 * state updates) never gives the browser a chance to paint or handle input: every await that
 * resolves from an already-settled promise (or a microtask) resumes in the same task, so the whole
 * loop can run as one long task. Awaiting this between items hands the thread back, so progress
 * state actually renders and the page stays scrollable/clickable.
 *
 * `scheduler.yield()` is the browser-native version when available (it continues at the front of
 * the task queue, behind input); the `setTimeout` fallback is a macrotask boundary, which browsers
 * paint and process input across. Both are cheap enough to call once per item.
 */
type SchedulerLike = { yield?: () => Promise<void> }

export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}
