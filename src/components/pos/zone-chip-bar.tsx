'use client'

import { ConciergeBell } from 'lucide-react'
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
  onCounterSelect: () => void
  /**
   * Whether to show the Counter tab at all.
   *
   * Kitchen staff cannot open, read or close counter sales — `/api/sessions` is
   * owner + waiter. Showing them the tab led somewhere that reads "No counter
   * sales", indistinguishable from a genuinely empty bar, with a create button
   * that always 403s.
   */
  showCounter: boolean
}

/**
 * Zone filter — one row of tabs with per-zone occupancy.
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
  onCounterSelect,
  showCounter,
}: ZoneChipBarProps) {
  const tabBase = cn(
    'flex h-touch-waiter shrink-0 items-center gap-sp-3 rounded-control px-sp-5',
    'border transition-[transform,box-shadow,background-color] duration-120 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  // brand-700, not brand-500: white text on brand-500 is 3.9:1 and fails AA at
  // these sizes — the same trap the --*-band tokens exist to avoid.
  const activeTab = 'border-brand-800 bg-brand-800 shadow-el-2 inset-shadow-top'
  const inactiveTab = 'border-slate-200 bg-white shadow-el-1'

  const AllIcon = ALL_ZONES_ICON
  // Counter mode overrides the zone filter entirely, so "All zones" is only
  // active when we are actually looking at zones.
  const allActive = activeZoneId === null && !counterActive

  function tab(
    key: string,
    Icon: typeof ConciergeBell,
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
          className={cn('size-5 shrink-0', isActive ? 'text-white' : 'text-slate-600')}
          strokeWidth={2}
        />
        <span
          className={cn(
            'text-fs-16 font-semibold whitespace-nowrap',
            isActive ? 'text-white' : 'text-slate-900',
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
              isActive ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600',
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

      {/* Counter — orders belonging to no table at all (FR64).

          DELIBERATELY COUNTLESS, and it stays that way under the new design.
          Every tab above counts TABLES occupied out of tables that exist. A
          counter sale occupies no table, so there is no denominator to show;
          a bare number here would be active orders, read in an identically
          -styled badge as though it were occupancy. The cards themselves say
          how many there are, unambiguously. */}
      {showCounter
        ? tab(
            'counter',
            ConciergeBell,
            'Counter',
            null,
            counterActive,
            onCounterSelect,
            'Counter sales, which occupy no table',
          )
        : null}
    </div>
  )
}
