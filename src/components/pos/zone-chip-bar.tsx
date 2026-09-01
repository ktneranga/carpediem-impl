'use client'

import { cn } from '@/lib/utils'

export type Zone = {
  id: string
  name: string
}

export type ZoneChipBarProps = {
  zones: Zone[]
  /** null selects "All Zones". */
  activeZoneId: string | null
  onZoneChange: (zoneId: string | null) => void
}

/**
 * Horizontal zone filter. Presentational only — zones arrive as props; Story 3.2
 * loads them from the database.
 *
 * Filtering applies on tap with no Apply button: a waiter switching zones
 * mid-service should not pay a second interaction for it.
 */
export function ZoneChipBar({ zones, activeZoneId, onZoneChange }: ZoneChipBarProps) {
  const chipBase = cn(
    'min-h-11 shrink-0 rounded-full px-space-6 text-body font-medium',
    'transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
  )

  const activeChip = 'bg-brand-600 text-neutral-0'
  const inactiveChip = 'border border-neutral-200 bg-neutral-0 text-neutral-600 active:bg-neutral-100'

  return (
    <div
      role="group"
      aria-label="Filter tables by zone"
      // no-scrollbar: overflow chips stay reachable by swipe without a
      // scrollbar consuming vertical space on a tablet.
      className="flex gap-space-3 overflow-x-auto no-scrollbar py-space-2"
    >
      <button
        type="button"
        aria-pressed={activeZoneId === null}
        onClick={() => onZoneChange(null)}
        className={cn(chipBase, activeZoneId === null ? activeChip : inactiveChip)}
      >
        All Zones
      </button>

      {zones.map((zone) => {
        const isActive = zone.id === activeZoneId
        return (
          <button
            key={zone.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onZoneChange(zone.id)}
            className={cn(chipBase, isActive ? activeChip : inactiveChip)}
          >
            {zone.name}
          </button>
        )
      })}
    </div>
  )
}
