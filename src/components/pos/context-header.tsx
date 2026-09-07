'use client'

import { useSyncExternalStore } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

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
 * Fixed 72px context header: back, breadcrumb, title, meta, right-hand controls.
 *
 * This is the breadcrumb half of the no-tab-bar model. There is NO bottom tab
 * bar anywhere in this application, at any navigation level — an architectural
 * prohibition, not a styling preference. Navigation is linear and
 * workflow-driven: this header, the zone filter, and a bottom action strip
 * whose buttons change with the state of the selected table.
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

  const crumbButton = cn(
    'rounded-chip px-sp-1 text-fs-14 font-semibold text-brand-700',
    'transition-colors duration-80 ease-standard active:bg-brand-050',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  // Back targets the level above the current one: from a table, the zone; from a
  // zone, all zones. At the top there is nowhere to go, so no control is drawn.
  //
  // A table selected with no zone filter has no zone level above it, so back
  // goes all the way to zones rather than to a level that does not exist.
  const backTarget = tableLabel ? (zoneName ? 'zone' : 'zones') : zoneName ? 'zones' : null

  // Single source of truth for "are we below the top level" — the Back control
  // and the breadcrumb must never disagree about it.
  const showCrumbs = backTarget !== null

  return (
    <header className="flex h-18 shrink-0 items-center justify-between gap-sp-4 border-b border-slate-200 bg-white px-sp-4">
      <div className="flex min-w-0 items-center gap-sp-3">
        {backTarget ? (
          <button
            type="button"
            aria-label="Back"
            onClick={() => onNavigate(backTarget)}
            className={cn(
              'flex size-touch-standard shrink-0 items-center justify-center rounded-control',
              'border border-slate-200 bg-white text-slate-600 shadow-el-1',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <ChevronLeft aria-hidden="true" className="size-5" strokeWidth={2} />
          </button>
        ) : null}

        <div className="flex min-w-0 flex-col gap-sp-1">
          <span className="truncate text-fs-18 font-bold tracking-title text-slate-900">
            {restaurantName}
          </span>

          {/* Breadcrumb appears only below the top level. At the top there is
              nothing to navigate back to, so an inert "Zones" crumb would be noise.

              Gated on `showCrumbs`, the same condition as the Back control. The
              two used to derive independently — the trail on `zoneName`, Back on
              `tableLabel || zoneName` — so selecting a table while "All zones"
              was active drew a Back chevron above no trail at all, with nothing
              to say where back led. */}
          {showCrumbs ? (
            <nav aria-label="Breadcrumb" className="flex items-center gap-sp-1">
              <button type="button" onClick={() => onNavigate('zones')} className={crumbButton}>
                Zones
              </button>
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-slate-400" />

              {tableLabel ? (
                <>
                  {/* With no zone filter active there is no zone crumb to sit
                      between "Zones" and the table — the table was picked from
                      the unfiltered grid, so that is genuinely where back goes. */}
                  {zoneName ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onNavigate('zone')}
                        className={crumbButton}
                      >
                        {zoneName}
                      </button>
                      <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-slate-400"
                      />
                    </>
                  ) : null}
                  {/* Current location is not a control. */}
                  <span aria-current="page" className="text-fs-14 text-slate-600">
                    {tableLabel}
                  </span>
                </>
              ) : (
                <span aria-current="page" className="text-fs-14 text-slate-600">
                  {zoneName}
                </span>
              )}
            </nav>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-sp-3">
        {/* Names, not roles. Accountability is a design feature. */}
        <button
          type="button"
          onClick={onStaffTap}
          aria-label={`Signed in as ${staffName}. Switch user.`}
          className={cn(
            'min-h-touch-standard rounded-control border border-slate-200 bg-white px-sp-3',
            'text-fs-14 font-semibold text-slate-600 shadow-el-1',
            'transition-[transform,box-shadow] duration-80 ease-standard',
            'active:scale-[0.97] active:shadow-pressed',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          )}
        >
          {staffName}
        </button>

        {/* Empty during SSR and hydration, filled immediately after — see the
            clock store above. No suppressHydrationWarning needed. */}
        <span className="text-fs-14 font-semibold text-slate-600 tabular-nums">{time}</span>
      </div>
    </header>
  )
}
