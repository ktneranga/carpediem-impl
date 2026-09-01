'use client'

import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'

/**
 * Clock as an external store.
 *
 * `useSyncExternalStore` is React's primitive for reading a mutable external
 * source (here: wall-clock time) without breaking hydration. React renders
 * `getServerSnapshot` on the server AND during hydration, then swaps to the
 * client snapshot afterwards — so server and client markup always agree and no
 * mismatch warning is produced.
 *
 * A useState + useEffect version also works but sets state directly inside an
 * effect, which `react-hooks/set-state-in-effect` flags, and it paints one frame
 * later than this does.
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

export type ContextHeaderProps = {
  restaurantName: string
  staffName: string
  zoneName?: string | null
  tableLabel?: string | null
  onNavigate: (level: 'zones' | 'zone') => void
  /** Story 2.4 opens the PIN pad for user switching. Header only reports the tap. */
  onStaffTap?: () => void
}

/**
 * Always-visible header: restaurant name, breadcrumb, staff name, clock.
 *
 * There is NO bottom tab bar anywhere in this application, at any navigation
 * level. Navigation is linear and workflow-driven — an explicit architectural
 * prohibition (ux-design-specification.md:677), not a styling preference.
 */
export function ContextHeader({
  restaurantName,
  staffName,
  zoneName,
  tableLabel,
  onNavigate,
  onStaffTap,
}: ContextHeaderProps) {
  const time = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot)

  const crumbButton =
    'rounded-lg px-space-1 text-small font-medium text-brand-700 active:bg-brand-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600'

  return (
    <header className="flex items-center justify-between gap-space-4 border-b border-neutral-200 bg-neutral-0 px-space-4 py-space-3">
      <div className="flex min-w-0 flex-col gap-space-1">
        <span className="truncate text-h2 font-semibold text-neutral-900">{restaurantName}</span>

        {/* Breadcrumb appears only below the top level. At the top there is
            nothing to navigate back to, so an inert "Zones" crumb would be noise. */}
        {zoneName ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-space-1">
            <button type="button" onClick={() => onNavigate('zones')} className={crumbButton}>
              Zones
            </button>
            <span aria-hidden="true" className="text-small text-neutral-400">
              →
            </span>

            {tableLabel ? (
              <>
                <button type="button" onClick={() => onNavigate('zone')} className={crumbButton}>
                  {zoneName}
                </button>
                <span aria-hidden="true" className="text-small text-neutral-400">
                  →
                </span>
                {/* Current location is not a control. */}
                <span aria-current="page" className="text-small text-neutral-600">
                  Table {tableLabel}
                </span>
              </>
            ) : (
              <span aria-current="page" className="text-small text-neutral-600">
                {zoneName}
              </span>
            )}
          </nav>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-space-4">
        <button
          type="button"
          onClick={onStaffTap}
          aria-label={`Signed in as ${staffName}. Switch user.`}
          className={cn(
            'min-h-11 rounded-lg px-space-3 text-small font-medium text-neutral-600',
            'active:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
          )}
        >
          {staffName}
        </button>

        {/* Empty during SSR and hydration, filled immediately after — see the
            clock store above. No suppressHydrationWarning needed. */}
        <span className="text-small tabular-nums text-neutral-600">{time}</span>
      </div>
    </header>
  )
}
