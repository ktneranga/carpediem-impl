'use client'

import { Martini, type LucideIcon } from 'lucide-react'
import { ALL_ZONES_ICON, zoneIcon } from '@/lib/design'
import { cn } from '@/lib/utils'

export type Zone = {
  id: string
  name: string
  /** Tables in this zone with an open session. */
  occupiedCount: number
  /** Tables in this zone in total, including out-of-service ones. */
  tableCount: number
}

export type ZoneChipBarProps = {
  zones: Zone[]
  activeZoneId: string | null
  /** Occupied across every zone, for the "All zones" tab. */
  totalOccupiedCount: number
  /** Tables across every zone. */
  totalTableCount: number
  onZoneChange: (zoneId: string | null) => void
  /**
   * Whether the Counter view is showing (FR64).
   *
   * A MODE, not a filter. Counter orders occupy no zone, so they never appear
   * inside one or under "All zones" — mixing them in would make that tab a lie.
   */
  counterActive: boolean
  /**
   * The Bar tab (Teran, 2026-10-30): open bar tabs, after the zones. Absent
   * for a role that cannot open them.
   */
  bar?: { openCount: number; onSelect: () => void }
}

/**
 * Zone filter — one row of tabs with per-zone occupancy.
 *
 * ── Counter is NOT a tab here (2026-10-19) ───────────────────────────────────
 * It used to be the last chip. It is not a zone: a counter sale occupies no
 * table, appears under no zone filter and has no denominator, so sitting among
 * tabs that all read "occupied of total" implied a place on the floor it does
 * not have. It is a button in the floor header now, beside the legend.
 *
 * It FILTERS the grid; it does not navigate. There is no bottom tab bar
 * anywhere in this application at any level: navigation is linear and
 * workflow-driven, and this bar plus the context header's breadcrumb is the
 * whole of the model. Filtering applies on tap with no Apply button.
 *
 * ── The 2026-10-16 design: counts are OCCUPIED / TOTAL ───────────────────────
 * They used to read "3 open" — tables FREE, the number a waiter scans for when
 * seating a party. The new design reads "3/8", occupied out of total, which
 * answers a different question: how busy is this zone.
 *
 * Both are defensible and the change is deliberate, so the trap is worth
 * naming: the two differ in DIRECTION. "3" previously meant three tables
 * available; "3/8" now means three are taken and five are free. Anyone adding
 * a third number here should make it occupancy too, or say loudly that it is
 * not — an identically-styled figure that counts the opposite way is the
 * defect the old Counter chip was left countless to avoid.
 */
export function ZoneChipBar({
  zones,
  activeZoneId,
  totalOccupiedCount,
  totalTableCount,
  onZoneChange,
  counterActive,
  bar,
}: ZoneChipBarProps) {
  const tabBase = cn(
    'flex h-touch-waiter shrink-0 items-center gap-sp-3 rounded-control px-sp-5',
    'border transition-[transform,box-shadow,background-color] duration-120 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  // ── FLAT. No shadow on either state (2026-10-21) ───────────────────────────
  // The active tab carried `shadow-el-2 inset-shadow-top`. The inset is a 1px
  // white line drawn INSIDE the top edge, which on a solid brand-800 fill reads
  // as a second, lighter border above the real one — so the selected tab had an
  // edge treatment the design does not draw at all. Sampling the design down
  // through both states finds exactly one transition each: white straight to
  // #12556F when active, and a single #E2E8F0 rule when not.
  //
  // The inset belongs on things that are RAISED — a button you press. A tab is
  // a selected state, not a control sitting above the bar, and the white band
  // behind it is already doing the separating.
  //
  // brand-800, not brand-500: white text on brand-500 is 3.9:1 and fails AA at
  // these sizes — the same trap the --*-band tokens exist to avoid.
  const activeTab = 'border-brand-800 bg-brand-800'
  const inactiveTab = 'border-slate-200 bg-white night:border-night-hairline night:bg-night-card'

  const AllIcon = ALL_ZONES_ICON
  // Counter mode overrides the zone filter entirely, so "All zones" is only
  // active when we are actually looking at zones.
  const allActive = activeZoneId === null && !counterActive

  function tab(
    key: string,
    Icon: LucideIcon,
    name: string,
    count: string | null,
    isActive: boolean,
    onClick: () => void,
    spokenCount: string,
  ) {
    return (
      <button
        key={key}
        type="button"
        aria-pressed={isActive}
        onClick={onClick}
        className={cn(tabBase, isActive ? activeTab : inactiveTab)}
      >
        <Icon
          aria-hidden="true"
          // brand-700, matching the zone headings over the grid — sampled off
          // every unselected tab in the design, all four exactly #1A6A8C.
          // Grey made the icon a bullet in front of the name; in brand it is
          // the same mark that labels the zone's block of cards and sits on
          // every card in it, so a waiter can jump tab -> heading -> card
          // without rereading any of the words.
          className={cn('size-5 shrink-0', isActive ? 'text-white' : 'text-brand-700 night:text-brand-300')}
          strokeWidth={2}
        />
        <span
          className={cn(
            'text-fs-16 font-semibold whitespace-nowrap',
            // slate-700 unselected, measured — slate-900 made every tab look
            // half-chosen, which is the one thing a filter bar must not do.
            isActive ? 'text-white' : 'text-slate-700 night:text-night-second',
          )}
        >
          {name}
        </span>
        {count ? (
          <span
            className={cn(
              'rounded-pill px-sp-2 py-0.5 text-fs-12 font-bold tabular-nums whitespace-nowrap',
              // Measured off the design: white at ~18% over brand-800.
              // A solid brand-900 badge read as a second, darker control.
              isActive ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600 night:bg-night-raised night:text-night-second',
            )}
          >
            {count}
          </span>
        ) : null}
        {/* The ratio reads as "three slash eight" otherwise, which says nothing. */}
        <span className="sr-only">{spokenCount}</span>
      </button>
    )
  }

  return (
    <div
      role="group"
      aria-label="Filter tables by zone"
      // no-scrollbar: overflow tabs stay reachable by swipe without a scrollbar
      // consuming vertical space on a tablet.
      className="no-scrollbar flex gap-sp-3 overflow-x-auto py-sp-1"
    >
      {tab(
        'all',
        AllIcon,
        'All zones',
        `${totalOccupiedCount}/${totalTableCount}`,
        allActive,
        () => onZoneChange(null),
        `${totalOccupiedCount} of ${totalTableCount} tables occupied`,
      )}

      {zones.map((zone) =>
        tab(
          zone.id,
          zoneIcon(zone.name),
          zone.name,
          `${zone.occupiedCount}/${zone.tableCount}`,
          activeZoneId === zone.id && !counterActive,
          () => onZoneChange(zone.id),
          `${zone.occupiedCount} of ${zone.tableCount} occupied`,
        ),
      )}

      {/* ── Bar, beside Rooftop (Teran, 2026-10-30) ──────────────────────
          Counter sales became BAR TABS and came back into this row, the
          reverse of the 2026-10-19 move to the header. A tab has no table,
          but the bar IS a place staff look at like a zone, and it belongs
          where they look.

          Its count is "N open", not a ratio: a bar has no number of tables to
          be out of. Worded in full so it cannot be read as one of the
          occupied/total figures beside it. */}
      {bar
        ? tab(
            'bar',
            Martini,
            'Bar',
            `${bar.openCount} open`,
            counterActive,
            bar.onSelect,
            `${bar.openCount} open bar ${bar.openCount === 1 ? 'tab' : 'tabs'}`,
          )
        : null}
    </div>
  )
}
