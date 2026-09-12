'use client'

import { STATUS_TONES, type TableStatus } from '@/lib/design'
import { elapsed, mergedTitle } from '@/lib/format'
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
  /** Staged for a merge — distinct from `selected`, which marks the anchor. */
  pendingMerge?: boolean
  /**
   * Every table on this session, in label order.
   *
   * Two or more means this card IS the group — one card for the whole party,
   * not one card per table with a badge explaining why two of them share a
   * timer. Story 3.8's amended AC-6: the member tables are not rendered as
   * separate cards at all while the session is open.
   */
  groupLabels?: string[]
  /**
   * Whether this card IS a group — decided by the grid, not re-derived here.
   *
   * The grid sets it from the server's own count of the session's tables. This
   * component used to recompute it from `groupLabels.length`, which is the rows
   * the grid managed to assemble — and when the two disagreed the card rendered
   * as an ordinary single table while still spanning two columns.
   */
  merged?: boolean
  /**
   * Span two grid columns.
   *
   * A merged card then occupies roughly the floor space of the tables it names,
   * which is the same reasoning as collapsing it in the first place — and it
   * buys the width that keeps `B2 + B3` off the truncation rule.
   */
  wide?: boolean
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
  pendingMerge = false,
  groupLabels = [],
  merged,
  wide = false,
  onSelect,
}: TableCardProps) {
  const tone = STATUS_TONES[status]
  const showOccupiedDetail = status === 'occupied' && elapsedMinutes !== undefined

  // `capacity` arrives already SUMMED for a group — the card does not add it up,
  // because only the grid knows which rows belong to the session.
  const isMerged = merged ?? groupLabels.length > 1
  const title = isMerged ? mergedTitle(groupLabels) : label
  // Named in full whenever the title had to shorten them. A waiter looking at
  // `B1 +2` otherwise has to select the card to find out where the party is
  // sitting — and the accessible name already reads every label, so the grid was
  // the only place the information was missing.
  const showFullGroup = isMerged && groupLabels.length > 2

  // REVISED in Story 3.7. This card previously refused clicks on `unavailable`
  // — `onClick={undefined}`, `aria-disabled`, no press feedback — because a tap
  // then meant "seat this table", and seating an out-of-service table is
  // nonsense.
  //
  // A tap now means "select this table"; the action strip decides what can be
  // done with it. Selecting an unavailable table is not only valid, it is the
  // only way an owner reaches "Return to service". So the card is operable
  // again, and `aria-disabled` is gone — it would now be a lie, because the
  // button does have an effect.
  //
  // The state is still unmistakable: red band, hatched body, "Not in service",
  // and an accessible name that says unavailable. What changed is that
  // unusable-for-seating no longer means unusable-as-a-control.

  // Accessible name carries the same facts the card shows, in the same order —
  // except that it names EVERY table in a group even when the visible title has
  // degraded to `Table 1 +2`. A screen-reader user must not be the only person
  // on the floor who cannot find out which tables the party is sitting at.
  const spokenName = isMerged ? `${spokenList(groupLabels)}, merged` : label
  const accessibleName = showOccupiedDetail
    ? `${spokenName}, ${tone.label.toLowerCase()}, ${elapsed(elapsedMinutes)}`
    : `${spokenName}, ${tone.label.toLowerCase()}`

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={accessibleName}
      // NOT aria-pressed. Selection here is mutually exclusive and cannot be
      // toggled off, so "pressed" promised a state change the control could not
      // deliver — activating a selected card did nothing and announced nothing.
      // aria-current marks "this is the one in context" without implying a
      // togglable state; the action strip carries the consequence.
      aria-current={selected || undefined}
      className={cn(
        // Saturated band + tinted body + matching edge, so status reads without
        // focusing. `overflow-hidden` is what lets the band meet the 20px corner
        // cleanly instead of poking a square shoulder through it.
        'relative flex h-30 flex-col overflow-hidden rounded-card border-2 text-left',
        // Only from `sm` up. At two columns a spanning card would be the entire
        // row, which on a phone-width viewport is just a card with no neighbours.
        wide && 'sm:col-span-2',
        'transition-[transform,box-shadow] duration-120 ease-standard',
        'active:scale-[0.97] active:shadow-pressed',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        // Three states, in priority order: the merge anchor, a table staged into
        // the merge, or neither. Staged tables get a dashed brand border so they
        // read as "about to join" rather than "already selected".
        selected
          ? 'border-brand-500 shadow-selected'
          : pendingMerge
            ? 'border-dashed border-brand-500 shadow-el-2'
            : cn(tone.edge, 'shadow-el-1'),
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
          {title}
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
            {showFullGroup ? (
              <span className={cn('truncate text-fs-12 font-semibold', tone.ink)}>
                {groupLabels.join(' + ')}
              </span>
            ) : null}
            <span className={cn('text-fs-12 tabular-nums', tone.ink)}>
              {itemCount !== undefined ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'No items yet'}
              {/* The table count is what tells a waiter this single card is a
                  party spread over several tables, and `seats` is their COMBINED
                  capacity — the number needed to place a party of seven, which
                  nobody could get before without adding up cards in their head. */}
              {isMerged && !showFullGroup ? ` · ${groupLabels.length} tables` : ''}
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

/**
 * `B2 and B3`, `B2, B3 and B4` — for the accessible name only.
 *
 * Separate from `mergedTitle` on purpose: that one truncates to fit a card band,
 * and truncation is a visual compromise that should not follow a table into
 * speech, where there is no width to run out of.
 */
function spokenList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
