'use client'

import { useSyncExternalStore } from 'react'

/**
 * A minute-resolution clock.
 *
 * Elapsed time must advance without refetching (Story 3.2 AC-8), and
 * `useSyncExternalStore` avoids the `react-hooks/set-state-in-effect` lint that
 * a useEffect + setState clock trips — the same issue Stories 2.1, 3.1 and 3.2
 * each hit in turn. A clock is an external store; treat it as one.
 *
 * WHAT IS SHARED IS THE SNAPSHOT, NOT THE TIMER. `useSyncExternalStore` calls
 * `subscribe` once per consuming component, so N components mean N intervals —
 * all reading one truncated timestamp, so they stay in lockstep and re-render
 * together, but they are not one timer. Fine at the two current consumers
 * (TableGrid, OrderScreen), which are never mounted at once. If this is ever
 * added to a per-card component, hoist the interval to a module-level singleton
 * with refcounting first, or you get one timer per table on screen.
 *
 * The interval is 30s, not 60s: it must be shorter than the minute it reports
 * or a tick can land a whole minute late.
 */
let cachedMinuteStamp = 0

function subscribeToMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, 30_000)
  return () => clearInterval(timer)
}

/**
 * Returns "now" truncated to the minute, in milliseconds.
 *
 * The store owns the `Date.now()` call. Reading the clock during render is
 * impure (react-hooks/purity) — an unrelated re-render would produce a different
 * elapsed time and React makes no promise about when renders happen. Truncating
 * also keeps the snapshot referentially stable between ticks, which
 * useSyncExternalStore requires to avoid an infinite render loop.
 */
function getMinuteSnapshot(): number {
  const minuteStamp = Math.floor(Date.now() / 60_000) * 60_000
  if (minuteStamp !== cachedMinuteStamp) cachedMinuteStamp = minuteStamp
  return cachedMinuteStamp
}

function getServerMinuteSnapshot(): number {
  // 0 on the server: elapsed time is meaningless in SSR output and any real
  // value would differ at hydration.
  return 0
}

export function useMinuteTick(): number {
  return useSyncExternalStore(subscribeToMinute, getMinuteSnapshot, getServerMinuteSnapshot)
}

/**
 * Pure: derives elapsed minutes from a timestamp against a supplied "now".
 *
 * The `Number.isFinite` guard below is load-bearing: an unparseable timestamp
 * yields NaN, and `Math.max(0, NaN)` is NaN, which would slip past the
 * clock-skew clamp and render "NaNh NaNm". The socket payload is not validated
 * on receipt, so that is reachable from any emitter sending something other
 * than an ISO string. Do not remove the guard on the grounds that openedAt
 * "is always an ISO string" — nothing enforces that at the boundary.
 */
export function elapsedMinutesFrom(
  openedAt: string | null,
  nowMs: number,
): number | undefined {
  if (!openedAt || nowMs === 0) return undefined
  const openedMs = new Date(openedAt).getTime()
  if (!Number.isFinite(openedMs)) return undefined
  return Math.max(0, Math.floor((nowMs - openedMs) / 60_000))
}
