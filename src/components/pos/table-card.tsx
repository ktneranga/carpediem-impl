'use client'

import { STATUS_TONES, type TableStatus } from '@/lib/design'
import { elapsed } from '@/lib/format'
import { cn } from '@/lib/utils'

export type { TableStatus }

export type TableCardProps = {
  /** Free text as stored — "R03", "T12". Do not prefix it. */
  label: string
  zoneName: string
  status: TableStatus
  /** Seat count from `tables.capacity`. Absent on tables never given one. */
  capacity?: number | null
  elapsedMinutes?: number
  itemCount?: number
  selected?: boolean
  onSelect: () => void
}

export function TableCard({
  label,
  zoneName,
  status,
  capacity,
  elapsedMinutes,
  itemCount,
  selected = false,
  onSelect,
}: TableCardProps) {
  const tone = STATUS_TONES[status]
  const showOccupiedDetail = status === 'occupied' && elapsedMinutes !== undefined

  // An unavailable table cannot be seated, so the card is not an operable
  // control — and it must say so to assistive tech, not just to the mouse.
  // Guarding only in the caller left a focusable button that announced itself as
  // a toggle, animated on press, and did nothing; and any future consumer that
  // forgot the caller-side guard silently lost the behaviour entirely.
  const isInert = status === 'unavailable'

  // Accessible name carries the same facts the card shows, in the same order.
  const accessibleName = showOccupiedDetail
    ? `${label}, ${tone.label.toLowerCase()}, ${elapsed(elapsedMinutes)}`
    : `${label}, ${tone.label.toLowerCase()}`

  return (
    <button
      type="button"
      onClick={isInert ? undefined : onSelect}
      aria-label={accessibleName}
      aria-disabled={isInert || undefined}
      aria-pressed={isInert ? undefined : selected}
      className={cn(
        // Saturated band + tinted body + matching edge, so status reads without
        // focusing. `overflow-hidden` is what lets the band meet the 20px corner
        // cleanly instead of poking a square shoulder through it.
        'relative flex h-30 flex-col overflow-hidden rounded-card border-2 text-left',
        'transition-[transform,box-shadow] duration-120 ease-standard',
        // No press feedback on an inert card — animating a tap that does nothing
        // reads as the app having missed the input.
        !isInert && 'active:scale-[0.97] active:shadow-pressed',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        // Selection is three simultaneous signals — 2px brand border, el-3, and
        // a 30% blue halo — because outdoors one signal is not enough.
        selected ? 'border-brand-500 shadow-selected' : cn(tone.edge, 'shadow-el-1'),
      )}
    >
      {/* Band — the half a waiter reads from ten metres. */}
      <span
        className={cn(
          'flex shrink-0 items-center justify-between gap-sp-2 px-sp-3 py-sp-2',
          // brand-700, not brand-500: white text on brand-500 is 3.9:1 and fails
          // AA at these sizes, the same trap the --*-band tokens exist to avoid.
          selected ? 'bg-brand-700' : tone.band,
        )}
      >
        <span className="truncate text-fs-18 font-extrabold tracking-title text-white">
          {label}
        </span>
        {/* The word, always. Hue is accompanied by the label; the label is not
            optional — so selection is carried by the border, elevation and halo,
            and never by replacing the one thing that must not be misread. */}
        <span className="shrink-0 text-fs-12 font-semibold tracking-micro text-white uppercase">
          {tone.label}
        </span>
      </span>

      {/* Body — tinted, and hatched on unavailable so the state survives even if
          hue fails entirely (glare, greyscale, colour blindness). */}
      <span
        className={cn(
          'relative flex flex-1 flex-col justify-center gap-sp-1 px-sp-3 py-sp-2',
          selected ? 'bg-white' : tone.body,
          status === 'unavailable' && 'hatch-unavailable',
        )}
      >
        {status === 'occupied' ? (
          <>
            <span className={cn('text-fs-16 font-semibold tabular-nums', tone.ink)}>
              {elapsedMinutes !== undefined ? elapsed(elapsedMinutes) : '—'}
            </span>
            <span className={cn('text-fs-12 tabular-nums', tone.ink)}>
              {itemCount !== undefined ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'No items yet'}
              {capacity != null ? ` · seats ${capacity}` : ''}
            </span>
          </>
        ) : status === 'unavailable' ? (
          <span className={cn('text-fs-14 font-semibold', tone.ink)}>Not in service</span>
        ) : (
          <>
            <span
              className={cn('text-fs-16 font-semibold', selected ? 'text-slate-900' : tone.ink)}
            >
              Ready to seat
            </span>
            {capacity != null ? (
              <span className={cn('text-fs-12 tabular-nums', selected ? 'text-slate-600' : tone.ink)}>
                seats {capacity}
              </span>
            ) : null}
          </>
        )}

        <span className="sr-only">{zoneName}</span>
      </span>
    </button>
  )
}
