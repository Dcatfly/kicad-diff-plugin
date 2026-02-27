// ─── Scheduling hooks: rAF coalescing + setTimeout debounce ───

import { useCallback, useEffect, useRef } from 'react'

/**
 * rAF-coalesced scheduler hook.
 * Multiple calls within one frame only execute the callback once (last wins).
 * Automatically cancels on unmount.
 * Returns [schedule, cancel].
 */
export function useRafScheduler(callback: () => void): [schedule: () => void, cancel: () => void] {
  const callbackRef = useRef(callback)
  useEffect(() => { callbackRef.current = callback })

  const idRef = useRef(0)

  const cancel = useCallback(() => {
    if (idRef.current) {
      cancelAnimationFrame(idRef.current)
      idRef.current = 0
    }
  }, [])

  useEffect(() => () => { cancel() }, [cancel])

  const schedule = useCallback(() => {
    cancel()
    idRef.current = requestAnimationFrame(() => {
      idRef.current = 0
      callbackRef.current()
    })
  }, [cancel])

  return [schedule, cancel]
}

/**
 * setTimeout-based debounce scheduler hook.
 * Resets the timer on each call; callback fires after `delay` ms of inactivity.
 * Automatically cancels on unmount.
 * Returns [schedule, cancel].
 */
export function useDebounceScheduler(callback: () => void, delay: number): [schedule: () => void, cancel: () => void] {
  const callbackRef = useRef(callback)
  useEffect(() => { callbackRef.current = callback })

  const idRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    if (idRef.current !== null) {
      clearTimeout(idRef.current)
      idRef.current = null
    }
  }, [])

  useEffect(() => () => { cancel() }, [cancel])

  const schedule = useCallback(() => {
    cancel()
    idRef.current = setTimeout(() => {
      idRef.current = null
      callbackRef.current()
    }, delay)
  }, [cancel, delay])

  return [schedule, cancel]
}

/**
 * Run an async mapper over items with bounded concurrency.
 * Resolves when all items are processed. Respects a cancellation check
 * called before each item starts.
 */
export async function parallelMap<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  opts: { concurrency?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
  const { concurrency = 4, isCancelled } = opts
  let idx = 0

  const run = async () => {
    while (idx < items.length) {
      if (isCancelled?.()) return
      const i = idx++
      await fn(items[i])
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  await Promise.all(workers)
}
