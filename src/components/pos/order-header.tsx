'use client'

import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The order screen's header — one compact row instead of a card.
 *
 * ── Why this is not `ContextHeader` ──────────────────────────────────────────
 * That component is the FLOOR screen's header and `table-grid.tsx` still uses
 * it. This screen needs different facts in less space, and restyling a shared
 * component to suit one of its two callers is how the floor plan ends up
 * redesigned by accident.
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
  statusLabel,
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
  statusLabel: string
  staffName: string
  /** Wall clock, "12:46". Ticks with the caller's minute tick. */
  clock: string
  onBack: () => void
  onStaffTap: () => void
}) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-sp-3 border-b border-slate-200 bg-white px-sp-4 py-sp-3">
      <div className="flex min-w-0 items-start gap-sp-3">
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

      <div className="flex shrink-0 items-center gap-sp-3">
        {/* The tinted pair, same as the floor cards: a coloured pill ALWAYS
            carries its word. Colour alone never states a status in this system. */}
        <span
          className={cn(
            'flex items-center gap-sp-2 rounded-control px-sp-3 py-sp-2',
            'bg-occupied-chip text-fs-14 font-bold text-occupied-ink',
          )}
        >
          <span aria-hidden="true" className="size-2 rounded-pill bg-occupied-band" />
          {statusLabel}
        </span>

        <button
          type="button"
          onClick={onStaffTap}
          aria-label={`Signed in as ${staffName}. Switch user.`}
          className={cn(
            // A control, so it gets the 56px floor like every other one.
            'flex min-h-touch-kitchen items-center gap-sp-2 rounded-control px-sp-3 text-fs-14',
            'font-semibold text-slate-900',
            'transition-[transform,box-shadow] duration-80 ease-standard',
            'active:scale-[0.97]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          )}
        >
          {staffName}
          <span className="tabular-nums text-slate-600">{clock}</span>
        </button>
      </div>
    </header>
  )
}
