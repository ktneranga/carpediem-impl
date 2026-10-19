'use client'

import { useSyncExternalStore } from 'react'

/**
 * Clock as an external store.
 *
 * `useSyncExternalStore` is React's primitive for reading a mutable external
 * source (here: wall-clock time) without breaking hydration. React renders
 * `getServerSnapshot` on the server AND during hydration, then swaps to the
 * client snapshot afterwards — so server and client markup always agree and no
 * mismatch warning is produced.
 */
function subscribeToClock(onChange: () => void): () => void {
  const timer = setInterval(onChange, 30_000)
  return () => clearInterval(timer)
}

// getSnapshot must return a referentially stable value between ticks — building
// a fresh string every call would re-render forever. Cached per minute.
let cachedMinute = -1
let cachedLabel = ''

function getClockSnapshot(): string {
  const now = new Date()
  const minuteOfDay = now.getHours() * 60 + now.getMinutes()

  if (minuteOfDay !== cachedMinute) {
    cachedMinute = minuteOfDay
    cachedLabel = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  return cachedLabel
}

/** Blank on the server — there is no meaningful "now" to commit to at build time. */
function getServerClockSnapshot(): string {
  return ''
}

/**
 * The wall clock as `HH:MM`, safe to render on the server.
 *
 * Extracted from `context-header.tsx` on 2026-10-19 so the floor's own header
 * can show the same time without a second copy of the store. Two copies would
 * each keep their own cached minute and their own interval, and could show
 * different times on one screen.
 */
export function useClock(): string {
  return useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot)
}
