'use client'

import { Clock, Split } from 'lucide-react'
import { STATUS_TONES, type TableStatus } from '@/lib/design'
import { elapsed, lkrFromPaisa, mergedTitle } from '@/lib/format'
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
  /**
   * What the open order has run up, in paisa. Undefined when there is no session.
   *
   * On the card because the mockup puts it there: a waiter crossing the floor
   * can see what a table is standing at without opening it. It is the sum of
   * what was sent, at the prices quoted — NOT a bill. Service charge, tax,
   * comps and discounts are Epic 6's, and none of them is in this number.
   */
  totalPaisa?: number
  /** Why the table is out of service. Shown under "Not in service". */
  unavailableReason?: string | null
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
  totalPaisa,
  unavailableReason,
  selected = false,
  pendingMerge = false,
  groupLabels = [],
  merged,
  wide = false,
  onSelect,
}: TableCardProps) {
  const tone = STATUS_TONES[status]
  const StatusIcon = tone.icon
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
  const accessibleName = [
    spokenName,
    tone.label.toLowerCase(),
    showOccupiedDetail ? elapsed(elapsedMinutes) : null,
    // The same facts the card shows, in the same order — the money and the
    // out-of-service reason included, or a screen-reader user would be the only
    // person on the floor who cannot tell what a table is standing at, or why
    // it is off the floor.
    status === 'occupied' && totalPaisa ? lkrFromPaisa(totalPaisa) : null,
    status === 'unavailable' && unavailableReason ? unavailableReason : null,
  ]
    .filter(Boolean)
    .join(', ')

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
        //
        // 152px, raised from 120px on 2026-09-20: a merged occupied card now
        // carries four lines — the timer, the items, the running total and the
        // group — and at 120px the last of them was clipped by the
        // `overflow-hidden` above, silently and only on the busiest cards.
        'relative flex h-38 flex-col overflow-hidden rounded-card border-2 text-left',
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
        {/* The word, always — and now the glyph beside it, which is the design
            system's "colour is never alone" rule taken to the letter. Hue is
            accompanied by the label; the label is not optional — so selection
            is carried by the border, elevation and halo, and never by replacing
            the one thing that must not be misread. */}
        <span className="flex shrink-0 items-center gap-sp-1 text-fs-12 font-semibold tracking-micro text-white uppercase">
          <StatusIcon aria-hidden="true" strokeWidth={2.5} className="size-3.5" />
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
            {/* The clock, from the mockup. How long a party has been sitting is
                the first thing read on an occupied card, and the glyph is what
                lets it be read as a duration rather than as a quantity. */}
            <span className={cn('flex items-center gap-sp-1 text-fs-16 font-bold tabular-nums', tone.ink)}>
              <Clock aria-hidden="true" strokeWidth={2.5} className="size-4 shrink-0" />
              {elapsedMinutes !== undefined ? elapsed(elapsedMinutes) : '—'}
            </span>
            <span className={cn('truncate text-fs-12 tabular-nums', tone.ink)}>
              {itemCount !== undefined ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'No items yet'}
              {/* `seats` is the group's COMBINED capacity — the number needed to
                  place a party of seven, which nobody could get before without
                  adding up cards in their head. The mockup reads "3 covers"
                  here; covers are not captured anywhere yet (see the note in
                  `deferred-work.md`), and a card that says "1 cover" on every
                  table would be worse than one that says what it knows. */}
              {capacity != null ? ` · seats ${capacity}` : ''}
            </span>
            {/* The running total, the mockup's most prominent line after the
                title. Absent rather than "LKR 0" before anything is sent: an
                order with nothing on it has no total, and a zero reads as a
                table that has been sitting for an hour ordering nothing. */}
            {totalPaisa ? (
              <span className={cn('text-fs-18 font-extrabold tabular-nums', tone.ink)}>
                {lkrFromPaisa(totalPaisa)}
              </span>
            ) : null}
            {/* Which other tables the party is on. The mockup writes it
                "Merged with T07"; with more than one other table the labels are
                listed instead, because naming them is the whole point — a
                waiter looking at `B1 +2` otherwise has to open the card to find
                out where the party is sitting. */}
            {isMerged ? (
              <span className={cn('flex items-center gap-sp-1 truncate text-fs-12 font-semibold', tone.ink)}>
                <Split aria-hidden="true" strokeWidth={2.5} className="size-3.5 shrink-0" />
                <span className="truncate">
                  {showFullGroup
                    ? groupLabels.join(' + ')
                    : `Merged with ${groupLabels.filter((other) => other !== label).join(', ')}`}
                </span>
              </span>
            ) : null}
          </>
        ) : status === 'unavailable' ? (
          <>
            <span className={cn('text-fs-14 font-semibold', tone.ink)}>Not in service</span>
            {/* The REASON, which the API has always returned and the card has
                never shown — "Sun bed broken" in the mockup. Without it an owner
                has to open the table to find out why it is off the floor, and
                the person who took it off already typed the answer. */}
            {unavailableReason ? (
              <span className={cn('truncate text-fs-12', tone.ink)}>{unavailableReason}</span>
            ) : null}
          </>
        ) : (
          <>
            <span
              className={cn('text-fs-16 font-semibold', selected ? 'text-slate-900' : tone.ink)}
            >
              Ready to seat
            </span>
            {capacity != null ? (
              <span className={cn('text-fs-12 tabular-nums', selected ? 'text-slate-600' : tone.ink)}>
                Seats {capacity}
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
