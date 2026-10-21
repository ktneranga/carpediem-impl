'use client'

import { ConciergeBell } from 'lucide-react'
import { StaffBadge } from '@/components/pos/staff-badge'
import { cn } from '@/lib/utils'

/**
 * The floor plan's own header (2026-10-19 design).
 *
 * ── Why not `ContextHeader` ──────────────────────────────────────────────────
 * That one is a BREADCRUMB header: restaurant name, then Zones › Table, with a
 * Back chevron. It is right for the order screen, which is somewhere you have
 * navigated TO.
 *
 * The floor is the top level — there is nowhere back to — so the breadcrumb was
 * always half-empty there, and the design replaces it with the three things a
 * waiter actually wants on arrival: what the floor is doing, what the colours
 * mean, and the one action that is not a table.
 *
 * `ContextHeader` is left alone rather than given a fourth mode. The two
 * headers now say different things because the two screens ARE different, and
 * a shared component with a boolean for "is this the floor" would have been the
 * same divergence with more indirection.
 *
 * ── The legend lives here, not on the cards ──────────────────────────────────
 * The card states are already self-describing — a clock, a green dot beside
 * "2 seats", a warning glyph, a hatch. This is a key for the colour, not the
 * only way to read it, which is why it can sit in the chrome and be ignored.
 */
export function FloorHeader({
  occupiedCount,
  openCount,
  staleCount,
  staffName,
  clock,
  showCounterSale,
  counterActive,
  onCounterSale,
  onStaffTap,
}: {
  occupiedCount: number
  openCount: number
  /** Occupied past the stale threshold. The row is omitted when there are none. */
  staleCount: number
  staffName: string
  clock: string
  /**
   * Kitchen staff cannot open, read or close counter sales — `/api/sessions`
   * is owner + waiter — so they are not offered the button.
   */
  showCounterSale: boolean
  counterActive: boolean
  onCounterSale: () => void
  onStaffTap: () => void
}) {
  return (
    // h-18/72px, measured off the design — the white band above the zone bar.
    <header className="flex h-18 shrink-0 items-center justify-between gap-sp-4 border-b border-slate-200 bg-white px-sp-4">
      <div className="flex min-w-0 flex-col">
        <h1 className="text-fs-20 font-extrabold tracking-title text-slate-900">Floor</h1>
        <p className="text-fs-12 font-semibold tabular-nums text-slate-600">
          {occupiedCount} occupied · {openCount} open
          {/* Only when there IS something to check. A permanent "0 to check"
              trains people to stop reading the row. */}
          {staleCount > 0 ? (
            <span className="text-unavailable-band"> · {staleCount} to check</span>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-sp-4">
        <ul className="flex items-center gap-sp-3" aria-label="What the card colours mean">
          {([
            ['bg-open-edge', 'Open'],
            ['bg-occupied-edge', 'Occupied'],
            ['bg-unavailable-edge', 'Needs check'],
          ] as const).map(([dot, text]) => (
            <li key={text} className="flex items-center gap-sp-2">
              <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-pill', dot)} />
              <span className="text-fs-12 font-semibold whitespace-nowrap text-slate-600">
                {text}
              </span>
            </li>
          ))}
        </ul>

        {/* Counter sale was a TAB in the zone bar. It is not a zone — a counter
            order occupies no table and appears under no zone filter — so
            sitting among them implied a place on the floor it does not have.
            As a header button it reads as what it is: the one action here that
            is not about a table. */}
        {showCounterSale ? (
          <button
            type="button"
            aria-pressed={counterActive}
            onClick={onCounterSale}
            className={cn(
              'flex h-touch-standard items-center gap-sp-2 rounded-control px-sp-4',
              'border text-fs-14 font-bold',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              counterActive
                ? 'border-brand-800 bg-brand-800 text-white shadow-el-2'
                : 'border-brand-500 bg-brand-050 text-brand-700 shadow-el-1',
            )}
          >
            <ConciergeBell aria-hidden="true" strokeWidth={2.2} className="size-4 shrink-0" />
            Counter sale
          </button>
        ) : null}

        <StaffBadge staffName={staffName} clock={clock} onTap={onStaffTap} />
      </div>
    </header>
  )
}
