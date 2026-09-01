'use client'

import { cn } from '@/lib/utils'

/**
 * Values match `tableStatusEnum` in the schema EXACTLY:
 *   pgEnum('table_status', ['open', 'occupied', 'unavailable'])
 *
 * epics.md calls the third state "closed" and the UX spec calls it "alert".
 * Neither exists in the database. `alert` is the colour token used to render
 * `unavailable`, not a status. Using the wrong name here means Story 3.2 passes
 * `unavailable` from the query and the card silently renders unstyled.
 */
export type TableStatus = 'open' | 'occupied' | 'unavailable'

export type TableCardProps = {
  /** Free text as stored — "R2", "Table 4". Do not prefix it. */
  label: string
  zoneName: string
  status: TableStatus
  elapsedMinutes?: number
  itemCount?: number
  selected?: boolean
  onSelect: () => void
}

const STATUS_LABEL: Record<TableStatus, string> = {
  open: 'Open',
  occupied: 'Occupied',
  unavailable: 'Unavailable',
}

const STATUS_DOT: Record<TableStatus, string> = {
  open: 'bg-status-open',
  occupied: 'bg-status-occupied',
  unavailable: 'bg-status-alert',
}

export function TableCard({
  label,
  zoneName,
  status,
  elapsedMinutes,
  itemCount,
  selected = false,
  onSelect,
}: TableCardProps) {
  const showOccupiedDetail = status === 'occupied' && elapsedMinutes !== undefined

  // Accessible name merges both specs: epics wanted "Table 4 — Occupied", the UX
  // spec wanted "Table R2, occupied, 42 minutes". Elapsed time is included only
  // when it exists, so a non-occupied card is not padded with meaningless detail.
  const accessibleName = showOccupiedDetail
    ? `${label}, ${STATUS_LABEL[status].toLowerCase()}, ${elapsedMinutes} minutes`
    : `${label}, ${STATUS_LABEL[status].toLowerCase()}`

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={accessibleName}
      aria-pressed={selected}
      className={cn(
        // MINIMUM dimensions, not fixed ones. The ACs say "≥ 44px" and "≥ 80px",
        // and `size-*` would pin height exactly — clipping the four stacked rows
        // (label, zone, status, occupied detail) inside 44px of box.
        // Owner/compact baseline; the waiter variant enlarges via [data-context],
        // which layout.tsx sets server-side from the staff role.
        'min-h-11 min-w-11 waiter:min-h-20 waiter:min-w-20',
        'flex flex-col items-start justify-between gap-space-1 rounded-2xl p-space-3',
        'bg-neutral-0 text-left transition-colors active:bg-neutral-100',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        // Selected is signalled by border weight AND colour, never colour alone.
        selected
          ? 'border-2 border-brand-600 ring-2 ring-brand-200'
          : 'border border-neutral-200',
      )}
    >
      <span className="flex w-full items-center gap-space-1">
        {/* Decorative — the status word beside it carries the meaning, and the
            aria-label carries it for assistive tech. */}
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])} />
        <span className="truncate text-h2 font-semibold text-neutral-900">{label}</span>
      </span>

      <span className="truncate text-micro text-neutral-600">{zoneName}</span>

      {/* Status as text, not colour alone (prd.md accessibility rule). */}
      <span className="text-micro font-medium text-neutral-600">{STATUS_LABEL[status]}</span>

      {showOccupiedDetail ? (
        <span className="text-micro text-neutral-600">
          {elapsedMinutes}m{itemCount !== undefined ? ` · ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''}
        </span>
      ) : null}
    </button>
  )
}
