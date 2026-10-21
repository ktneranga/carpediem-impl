'use client'

import { ArrowLeft } from 'lucide-react'
import { createElement } from 'react'
import { StaffBadge } from '@/components/pos/staff-badge'
import { zoneIcon } from '@/lib/design'
import { cn } from '@/lib/utils'

/**
 * The order screen's header — one compact row instead of a card.
 *
 * ── Why this is not `ContextHeader` ──────────────────────────────────────────
 * This screen needs different facts in less space than a breadcrumb header
 * carries, and restyling a shared component to suit one of its callers is how
 * the floor plan ends up redesigned by accident. The floor has since grown its
 * own `FloorHeader` for the same reason, which leaves `ContextHeader` with no
 * callers at all — it is kept, not wired, until something needs a breadcrumb.
 *
 * What the three DO share is `StaffBadge`, because who is signed in is the one
 * fact that does not change with the screen.
 *
 * ── What it replaced, and why ────────────────────────────────────────────────
 * The order screen used to carry `ContextHeader` AND a `<dl>` card below it
 * repeating the zone, the elapsed time and the covers — roughly 180px of
 * chrome before a waiter saw a single dish. All of it now sits on two lines.
 * On a tablet that is three more rows of menu, which is the whole point: the
 * design brief is beating the speed of just remembering the order.
 *
 * ── The second line is an affordance, not a label ────────────────────────────
 * "SEAT 1 SELECTED — TAPS LAND HERE" answers the question a waiter asks before
 * every single tap on this screen. It is in brand colour and it changes with
 * the selection, because a wrong answer here misattributes a dish to the wrong
 * person and only surfaces at the bill.
 */
export function OrderHeader({
  tableLabel,
  contextLine,
  activeSeatLabel,
  zoneName,
  staffName,
  clock,
  onBack,
  onStaffTap,
}: {
  /** "B1", "B1 + B3" for a merged group, or "Counter" for a counter sale. */
  tableLabel: string
  /** "Bean Bags · 2 of 4 covers · open 12 min" — already assembled by the caller. */
  contextLine: string
  /** Null only if a session somehow has no seats; the line is then hidden. */
  activeSeatLabel: string | null
  /**
   * The zone, for the tile beside the title. Null for a counter sale, which
   * belongs to no zone and gets the generic tile.
   */
  zoneName: string | null
  staffName: string
  /** Wall clock, "12:46". Ticks with the caller's minute tick. */
  clock: string
  onBack: () => void
  onStaffTap: () => void
}) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-sp-3 border-b border-slate-200 bg-white px-sp-4 py-sp-3">
      <div className="flex min-w-0 items-center gap-sp-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the floor plan"
          className={cn(
            // The 56px touch token: the floor for every waiter control.
            'flex size-touch-kitchen shrink-0 items-center justify-center rounded-control',
            'border border-slate-200 bg-white text-slate-900',
            'transition-[transform,box-shadow] duration-80 ease-standard',
            'active:scale-[0.97] active:shadow-pressed',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          )}
        >
          <ArrowLeft aria-hidden="true" strokeWidth={2.5} className="size-6" />
        </button>

        {/* The same amber tile the table wears on the floor while it is
            occupied — which this table is, by construction: the page redirects
            unless the session is open. It replaces the "Occupied" pill that
            used to sit on the right, because the pill said in a word what the
            context line underneath already says with a number ("open 38m"),
            and the tile carries the zone as well. */}
        <span
          aria-hidden="true"
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-control',
            'bg-occupied-edge text-white',
          )}
        >
          {createElement(zoneIcon(zoneName ?? ''), {
            strokeWidth: 2.2,
            className: 'size-5',
          })}
        </span>

        <div className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-baseline gap-x-sp-3 gap-y-sp-1">
            <h1 className="text-fs-24 font-extrabold tracking-title text-slate-900">
              {tableLabel}
            </h1>
            <p className="text-fs-14 text-slate-600">{contextLine}</p>
          </div>

          {activeSeatLabel ? (
            <p className="text-fs-12 font-bold tracking-micro text-brand-700 uppercase">
              {activeSeatLabel} selected — taps land here
            </p>
          ) : null}
        </div>
      </div>

      {/* Was a plain "Nina 12:46" in a 56px pill while the floor drew the
          filled circle — the same control, two appearances, on two screens a
          waiter moves between constantly. One component now. */}
      <StaffBadge staffName={staffName} clock={clock} onTap={onStaffTap} />
    </header>
  )
}
