const TAIL_TIMEOUT = Symbol("google-stream-tail-timeout")
const TAIL_TIMEOUT_MS = 5_000

/** Wait briefly for optional usage after content finishes, never during generation. */
export async function* withGoogleStreamTailDeadline<T>(
  source: AsyncIterable<T>,
  hasTerminal: () => boolean,
  cancelUpstream: () => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: Promise<typeof TAIL_TIMEOUT> | undefined
  let timedOut = false
  try {
    while (true) {
      if (!deadline && hasTerminal()) {
        deadline = new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve(TAIL_TIMEOUT)
            cancelUpstream()
          }, TAIL_TIMEOUT_MS)
        })
      }
      const pending = iterator.next()
      const next =
        deadline ? await Promise.race([pending, deadline]) : await pending
      if (next === TAIL_TIMEOUT) {
        timedOut = true
        break
      }
      if (next.done) break
      yield next.value
    }
  } finally {
    clearTimeout(timer)
    const cleanup = iterator.return?.()
    if (timedOut) {
      // A stalled next() must not block completed output or leave a rejection unhandled.
      void cleanup?.catch(() => {})
    } else {
      await cleanup
    }
  }
}
