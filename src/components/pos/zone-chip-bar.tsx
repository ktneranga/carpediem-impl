'use client'

import { ALL_ZONES_ICON, zoneIcon } from '@/lib/design'
import { cn } from '@/lib/utils'

export type Zone = {
  id: string
  name: string
  /** Tables currently free in this zone. The number a waiter is actually scanning for. */
  openCount: number
}

export type ZoneChipBarProps = {
  zones: Zone[]
  activeZoneId: string | null
  /** Free tables across every zone, shown on the "All zones" chip. */
  totalOpenCount: number
  onZoneChange: (zoneId: string | null) => void
}

/**
 * Zone filter — 80px selector with per-zone open counts.
 *
 * It FILTERS the grid; it does not navigate. There is no bottom tab bar
 * anywhere in this application at any level: navigation is linear and
 * workflow-driven, and this bar plus the context header's breadcrumb is the
 * whole of the model.
 *
 * Filtering applies on tap with no Apply button — a waiter switching zones
 * mid-service should not pay a second interaction for it.
 */
export function ZoneChipBar({
  zones,
  activeZoneId,
  totalOpenCount,
  onZoneChange,
}: ZoneChipBarProps) {
  const chipBase = cn(
    'flex h-touch-waiter shrink-0 flex-col items-start justify-center gap-sp-1 rounded-control px-sp-4',
    'border transition-[transform,box-shadow,background-color] duration-120 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  const activeChip = 'border-brand-500 bg-brand-500 shadow-el-2 inset-shadow-top'
  const inactiveChip = 'border-slate-200 bg-white shadow-el-1'

  const AllIcon = ALL_ZONES_ICON
  const allActive = activeZoneId === null

  return (
    <div
      role="group"
      aria-label="Filter tables by zone"
      // no-scrollbar: overflow chips stay reachable by swipe without a
      // scrollbar consuming vertical space on a tablet.
      className="no-scrollbar flex gap-sp-3 overflow-x-auto py-sp-1"
    >
      <button
        type="button"
        aria-pressed={allActive}
        onClick={() => onZoneChange(null)}
        className={cn(chipBase, allActive ? activeChip : inactiveChip)}
      >
        <span className="flex items-center gap-sp-2">
          <AllIcon
            aria-hidden="true"
            className={cn('size-5 shrink-0', allActive ? 'text-white' : 'text-slate-600')}
            strokeWidth={2}
          />
          <span
            className={cn(
              'text-fs-16 font-semibold whitespace-nowrap',
              allActive ? 'text-white' : 'text-slate-900',
            )}
          >
            All zones
          </span>
        </span>
        <span
          className={cn(
            'text-fs-12 tabular-nums whitespace-nowrap',
            allActive ? 'text-brand-100' : 'text-slate-600',
          )}
        >
          {totalOpenCount} open
        </span>
      </button>

      {zones.map((zone) => {
        const isActive = activeZoneId === zone.id
        const Icon = zoneIcon(zone.name)

        return (
          <button
            key={zone.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onZoneChange(zone.id)}
            className={cn(chipBase, isActive ? activeChip : inactiveChip)}
          >
            <span className="flex items-center gap-sp-2">
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
                {zone.name}
              </span>
            </span>
            <span
              className={cn(
                'text-fs-12 tabular-nums whitespace-nowrap',
                isActive ? 'text-brand-100' : 'text-slate-600',
              )}
            >
              {zone.openCount} open
            </span>
          </button>
        )
      })}
    </div>
  )
}
