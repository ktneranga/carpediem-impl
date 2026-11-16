'use client'

import { CashDrawerButton } from '@/components/pos/cash-drawer-button'
import { StaffMenu } from '@/components/pos/staff-menu'
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
  onStaffTap,
  canOpenDrawer = false,
  isOwner = false,
  canOpenForChange = false,
  onDrawerOpened,
  onManage,
  onSoldOut,
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
  onStaffTap: () => void
  /** Owner and waiters: the cash drawer icon — float, cash in/out (Teran, 2026-11-16). */
  canOpenDrawer?: boolean
  /** May take cash out (paid out, cash drop). */
  isOwner?: boolean
  /** `open_cash_drawer`: may open for change with no money moving. */
  canOpenForChange?: boolean
  onDrawerOpened?: () => void
  /**
   * Owner only (Story 10.0): the badge opens a menu — Manage, Switch user.
   * Omitted, the badge switches user at once, as it always has.
   */
  onManage?: () => void
  /** Owner and waiters (Story 8.3): Sold out in the badge menu. */
  onSoldOut?: () => void
}) {
  return (
    // h-18/72px, measured off the design — the white band above the zone bar.
    <header className="flex h-18 shrink-0 items-center justify-between gap-sp-4 border-b border-slate-200 bg-white px-sp-4 night:border-night-hairline night:bg-night-card">
      <div className="flex min-w-0 flex-col">
        <h1 className="text-fs-20 font-extrabold tracking-title text-slate-900 night:text-night-text">Floor</h1>
        <p className="text-fs-12 font-semibold tabular-nums text-slate-600 night:text-night-second">
          {occupiedCount} occupied · {openCount} open
          {/* Only when there IS something to check. A permanent "0 to check"
              trains people to stop reading the row. */}
          {staleCount > 0 ? (
            <span className="text-unavailable-band night:text-red-400"> · {staleCount} to check</span>
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
              <span className="text-fs-12 font-semibold whitespace-nowrap text-slate-600 night:text-night-second">
                {text}
              </span>
            </li>
          ))}
        </ul>

        {/* No Counter sale button (2026-10-30): it became the Bar tab in the
            zone bar, beside Rooftop. */}

        <div className="flex items-center gap-sp-2">
          {canOpenDrawer ? (
            <CashDrawerButton isOwner={isOwner} canOpenForChange={canOpenForChange} onOpened={() => onDrawerOpened?.()} />
          ) : null}
          <StaffMenu staffName={staffName} clock={clock} onManage={onManage} onSoldOut={onSoldOut} onSwitchUser={onStaffTap} />
        </div>
      </div>
    </header>
  )
}
