'use client'

import { createElement } from 'react'
import { AlertTriangle, Ban, Split } from 'lucide-react'
import { STATUS_TONES, zoneIcon, type TableStatus } from '@/lib/design'
import { elapsed, lkrCompact, lkrFromPaisa, mergedTitle } from '@/lib/format'
import { cn } from '@/lib/utils'

export type { TableStatus }

export type TableCardProps = {
  /** Free text as stored — "R03", "T12". Do not prefix it. */
  label: string
  zoneName: string
  status: TableStatus
  /** Seat count from `tables.capacity`. Absent on tables never given one. */
  capacity?: number | null
  /** Guests seated, from `order_sessions.cover_count`. Absent with no session. */
  coverCount?: number | null
  elapsedMinutes?: number
  itemCount?: number
  /**
   * What the open order has run up, in paisa. Undefined when there is no session.
   *
   * Rendered COMPACT here ("LKR 4.3k"): the figure is a glance-value for a
   * waiter crossing the floor, not a sum anyone reconciles against, and the
   * exact rupees are two taps away on the order screen. The accessible name
   * still reads the full amount.
   *
   * It is the sum of what was sent, at the prices quoted — NOT a bill. Service
   * charge, tax and comps are Epic 6's, and none of them is in this number.
   */
  totalPaisa?: number
  /** Why the table is out of service. Shown under the label. */
  unavailableReason?: string | null
  /**
   * Occupied for longer than the floor's stale threshold.
   *
   * A DERIVED display state, not a status in the database — "occupied" that
   * has gone on too long. Decided by the grid, which owns the threshold, for
   * the same reason `merged` is: one card re-deriving it from its own
   * `elapsedMinutes` would drift from the heading count beside it.
   */
  needsCheck?: boolean
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

/**
 * One table on the floor.
 *
 * ── The 2026-10-16 design ────────────────────────────────────────────────────
 * Replaces the full-width coloured band with a filled ZONE-ICON TILE in the
 * corner and a tinted body. The band carried the status word across the whole
 * card top; the tile carries the same hue in a quarter of the space, which is
 * what buys room for the three facts the new design leads with — how long,
 * how full, how much.
 *
 * ── Colour is still never alone ──────────────────────────────────────────────
 * The rule survives the restyle, because it is an accessibility requirement
 * rather than a visual preference:
 *   · occupied    — a duration, top right. Nothing else shows a clock.
 *   · open        — a green dot AND "N seats". A dot alone would be hue only.
 *   · needs check — a warning glyph and the words "Still open? Check".
 *   · unavailable — a slashed circle, the hatch pattern, and the words.
 * Every state is legible in greyscale, and the accessible name below reads the
 * same facts in the same order.
 */
export function TableCard({
  label,
  zoneName,
  status,
  capacity,
  coverCount,
  elapsedMinutes,
  itemCount,
  totalPaisa,
  unavailableReason,
  needsCheck = false,
  selected = false,
  pendingMerge = false,
  groupLabels = [],
  merged,
  wide = false,
  onSelect,
}: TableCardProps) {
  const tone = STATUS_TONES[status]
  const showOccupiedDetail = status === 'occupied' && elapsedMinutes !== undefined

  // `needsCheck` only means anything while occupied. A grid that passed it on
  // an open table would otherwise paint an empty table red.
  const stale = needsCheck && status === 'occupied'

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
  // only way an owner reaches "Return to service".

  // Accessible name carries the same facts the card shows, in the same order —
  // except that it names EVERY table in a group even when the visible title has
  // degraded to `Table 1 +2`, and it reads the FULL amount rather than the
  // compact one, because "four point three thousand rupees" is not a number
  // anyone wants read to them.
  const spokenName = isMerged ? `${spokenList(groupLabels)}, merged` : label
  const accessibleName = [
    spokenName,
    stale ? 'needs check' : tone.label.toLowerCase(),
    showOccupiedDetail ? elapsed(elapsedMinutes) : null,
    status === 'occupied' && coverCount != null
      ? `${coverCount} of ${capacity ?? coverCount} guests`
      : null,
    status === 'occupied' && totalPaisa ? lkrFromPaisa(totalPaisa) : null,
    status === 'open' && capacity != null ? `${capacity} seats` : null,
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
      // deliver. aria-current marks "this is the one in context" without
      // implying a togglable state; the action strip carries the consequence.
      aria-current={selected || undefined}
      className={cn(
        // h-33/132px and 12px padding, both measured off the design. It was
        // h-26/104px: the same three rows in 28px less, so `justify-between`
        // had almost nothing to distribute and the tile, the label and the
        // seat count sat in one dense clump. The height is what the padding
        // needs to be visible — the 12px was already right and did not look
        // it.
        'relative flex h-33 flex-col justify-between overflow-hidden rounded-card border p-sp-3 text-left',
        // Only from `sm` up. At two columns a spanning card would be the entire
        // row, which on a phone-width viewport is just a card with no neighbours.
        wide && 'sm:col-span-2',
        'transition-[transform,box-shadow] duration-120 ease-standard',
        'active:scale-[0.97] active:shadow-pressed',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        // Body tint carries the status; the hatch keeps `unavailable` legible
        // if hue fails entirely (glare, greyscale, colour blindness).
        status === 'unavailable'
          ? 'hatch-unavailable bg-slate-100'
          : stale
            ? 'bg-unavailable-body'
            : status === 'occupied'
              ? 'bg-occupied-body'
              : 'bg-white',
        // Selection is a RING, not a recolour: the status tint has to survive
        // being selected, or the waiter loses the one fact they selected it for.
        selected
          ? 'border-2 border-brand-500 shadow-selected'
          : pendingMerge
            ? 'border-2 border-dashed border-brand-500 shadow-el-2'
            : cn(
                'shadow-el-1',
                status === 'unavailable'
                  ? 'border-slate-200'
                  : stale
                    ? 'border-unavailable-edge'
                    : status === 'occupied'
                      ? 'border-occupied-line'
                      : 'border-slate-200',
              ),
      )}
    >
      {/* Top row — the zone tile, and the one fact that distinguishes the state. */}
      <span className="flex items-start justify-between gap-sp-2">
        <span
          className={cn(
            // 40px, measured. The same tile the action strip draws.
            'flex size-10 shrink-0 items-center justify-center rounded-control',
            // Filled while the table is in use, tinted while it is free. The
            // fill is what reads from across the room.
            status === 'unavailable'
              ? 'bg-slate-200 text-slate-400'
              : stale
                ? 'bg-unavailable-edge text-white'
                : status === 'occupied'
                  ? 'bg-occupied-edge text-white'
                  : 'bg-brand-050 text-brand-500',
          )}
        >
          {/* `createElement`, not `<ZoneIcon />`: `zoneIcon()` RETURNS a
              component, and calling it during render then using the result as
              JSX is what the compiler's "cannot create components during
              render" rule exists to catch. Same icon, no new component
              identity on every render. */}
          {createElement(zoneIcon(zoneName), {
            'aria-hidden': 'true',
            strokeWidth: 2.2,
            className: 'size-5',
          })}
        </span>

        {status === 'occupied' ? (
          stale ? (
            <span className="flex items-center gap-sp-1 pt-0.5 text-fs-12 font-bold text-unavailable-band">
              <AlertTriangle aria-hidden="true" strokeWidth={2.5} className="size-3.5 shrink-0" />
              Open {elapsedMinutes !== undefined ? elapsed(elapsedMinutes) : '—'}
            </span>
          ) : (
            <span className="pt-0.5 text-fs-12 font-bold tabular-nums text-occupied-ink">
              {elapsedMinutes !== undefined ? elapsed(elapsedMinutes) : '—'}
            </span>
          )
        ) : status === 'unavailable' ? (
          <Ban aria-hidden="true" strokeWidth={2.2} className="mt-0.5 size-4 shrink-0 text-slate-400" />
        ) : (
          // A free table's whole message is "nothing here yet", so the dot is
          // the entire top-right. It is never alone: "N seats" sits below it.
          <span
            aria-hidden="true"
            className="mt-1.5 size-3 shrink-0 rounded-pill bg-open-edge"
          />
        )}
      </span>

      {/* The label, and underneath it whatever this state has to say. */}
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-fs-24 font-extrabold tracking-title text-slate-900">
          {title}
        </span>

        {status === 'occupied' ? (
          stale ? (
            <span className="truncate text-fs-12 font-bold text-unavailable-band">
              Still open? Check
            </span>
          ) : (
            <span className="flex items-baseline justify-between gap-sp-2">
              <span className="truncate text-fs-12 font-semibold tabular-nums text-occupied-ink">
                {coverCount != null
                  ? `${coverCount}/${capacity ?? coverCount} guests`
                  : itemCount !== undefined
                    ? `${itemCount} item${itemCount === 1 ? '' : 's'}`
                    : 'No items yet'}
              </span>
              {/* Absent rather than "LKR 0" before anything is sent: an order
                  with nothing on it has no total, and a zero reads as a table
                  that has been sitting an hour ordering nothing. */}
              {totalPaisa ? (
                <span className="shrink-0 text-fs-12 font-extrabold tabular-nums text-occupied-ink">
                  {lkrCompact(totalPaisa)}
                </span>
              ) : null}
            </span>
          )
        ) : status === 'unavailable' ? (
          <span className="truncate text-fs-12 font-semibold text-slate-600">
            {unavailableReason || 'Out of service'}
          </span>
        ) : (
          <span className="text-fs-12 font-semibold tabular-nums text-slate-600">
            {capacity != null ? `${capacity} seats` : 'Ready to seat'}
          </span>
        )}

        {/* Which other tables the party is on. Named rather than counted: a
            waiter looking at `B1 +2` otherwise has to open the card to find out
            where the party is sitting. */}
        {isMerged ? (
          <span className="flex items-center gap-sp-1 truncate text-fs-12 font-semibold text-slate-600">
            <Split aria-hidden="true" strokeWidth={2.5} className="size-3 shrink-0" />
            <span className="truncate">
              {showFullGroup
                ? groupLabels.join(' + ')
                : `With ${groupLabels.filter((other) => other !== label).join(', ')}`}
            </span>
          </span>
        ) : null}
      </span>

      <span className="sr-only">{zoneName}</span>
    </button>
  )
}

/**
 * `B2 and B3`, `B2, B3 and B4` — for the accessible name only.
 *
 * Separate from `mergedTitle` on purpose: that one truncates to fit a card, and
 * truncation is a visual compromise that should not follow a table into speech,
 * where there is no width to run out of.
 */
function spokenList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
