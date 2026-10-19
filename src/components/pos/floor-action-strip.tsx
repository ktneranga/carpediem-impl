'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  ActionStripShell,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/components/pos/action-strip-chrome'
import { elapsed, mergedTitle } from '@/lib/format'
import type { StaffRole } from '@/server/auth/permissions'
import type { TableGridRow } from '@/app/api/tables/route'

/**
 * The floor screen's state-driven action strip.
 *
 * `ux-design-specification.md:297` — "Context-sensitive action strip at the
 * bottom: buttons change based on table state, never a fixed tab bar." Specified
 * since the UX spec was written and unbuilt until now, which is why table
 * availability had nowhere to live: before this strip existed, a tap on a card
 * opened a session, so there was no surface on which to offer "Return to
 * service" for a table that cannot be seated.
 *
 * Building it also changes how the grid works — a tap now SELECTS rather than
 * acting. See table-grid.tsx and Story 3.7's amendment to Story 3.3 AC-1.
 *
 * NOT the same component as Epic 4's `OrderActionStrip`, which is driven by
 * ORDER state on the order screen. This one is driven by TABLE state on the
 * floor. Whoever builds Story 4.1 should decide whether they converge.
 */

/** Common reasons, offered as one tap. Free text covers the rest. */
const QUICK_REASONS = ['Broken', 'Cover torn', 'Cleaning', 'Reserved'] as const

export type FloorActionStripProps = {
  table: TableGridRow | null
  role: StaffRole | null
  elapsedMinutes?: number
  busy?: boolean
  /**
   * Tables staged for a merge, or null when merge mode is off.
   *
   * Lives in TableGrid, not here: a merge set spans several selections by
   * definition, and this component is keyed on the selected table so its own
   * state is deliberately destroyed whenever the selection changes. That keying
   * is what stopped the reason prompt retargeting (Story 3.7's review) — merge
   * mode has to sit above it.
   */
  mergeTableIds: string[] | null
  /**
   * Labels of the staged tables, in the same order as `mergeTableIds`.
   *
   * Only the grid can resolve ids to labels, and the commit button has to NAME
   * the tables it is about to merge (AC-14) rather than count them. Passing the
   * labels down is cheaper than passing the whole table list twice.
   */
  mergeTableLabels: string[]
  /**
   * Every table on the selected session, in label order.
   *
   * The un-merge picker needs ids, and `TableGridRow.groupTableLabels` carries
   * labels only — deliberately, since the grid row is one table and the group is
   * assembled across rows.
   */
  groupTables: { id: string; label: string }[]
  onStartOrder: (tableId: string) => void
  onOpenOrder: (tableId: string) => void
  onTakeOutOfService: (tableId: string, reason: string) => void
  onReturnToService: (tableId: string) => void
  onBeginMerge: () => void
  onCancelMerge: () => void
  onConfirmMerge: () => void
  onUnmerge: (tableId: string) => void
  /**
   * The selected counter order, when the Counter view is showing (FR64).
   *
   * Counter orders have no table, so they cannot arrive through `table` — that
   * is a `TableGridRow`. Passing them separately keeps the table props honestly
   * table-shaped instead of turning every field nullable.
   */
  counter: { sessionId: string; label: string; elapsedMinutes?: number; itemCount: number } | null
  onOpenCounter: (sessionId: string) => void
  /**
   * The counter sale being seated, with the tables staged so far (AC-5).
   *
   * A guest buys at the bar and then sits down. The order does not move — the
   * TABLE joins it. Structurally this is merge mode with a counter session as
   * the anchor instead of a table, which is exactly what Story 3.8's join table
   * made possible.
   */
  seating: { sessionId: string; label: string; tableLabels: string[] } | null
  onBeginSeating: (sessionId: string) => void
  onCancelSeating: () => void
  onConfirmSeating: () => void
}

export function FloorActionStrip({
  table,
  role,
  elapsedMinutes,
  busy = false,
  mergeTableIds,
  mergeTableLabels,
  groupTables,
  onStartOrder,
  onOpenOrder,
  onTakeOutOfService,
  onReturnToService,
  onBeginMerge,
  onCancelMerge,
  onConfirmMerge,
  onUnmerge,
  counter,
  onOpenCounter,
  seating,
  onBeginSeating,
  onCancelSeating,
  onConfirmSeating,
}: FloorActionStripProps) {
  const [reasonOpen, setReasonOpen] = useState(false)
  const [customReason, setCustomReason] = useState('')
  const [unmergeOpen, setUnmergeOpen] = useState(false)

  // Two or more tables on one session. Read from `groupTables` rather than the
  // row's own `groupTableLabels` so the strip and the grid agree on what a group
  // IS from a single source — the grid assembles it, this only renders it.
  const isMerged = groupTables.length > 1

  // Kitchen staff reach this screen — no policy covers `/`, so the grid is
  // default-allow — but every write beneath /api/tables and the /tables page
  // itself are owner + waiter. Offering buttons that always 403 is the same
  // defect as the dead "Switch user" control two stories ago; the server refusal
  // is the enforcement, this is so nobody is invited to fail.
  const canSeat = role === 'owner' || role === 'waiter'

  // Moved to action-strip-chrome.tsx in Story 4.1, unchanged, so the second
  // strip cannot copy them a third time and drift.
  const primary = primaryButtonClass
  const secondary = secondaryButtonClass

  function submitReason(reason: string) {
    const trimmed = reason.trim()
    if (!trimmed || !table || busy) return
    // The panel stays open until the mutation succeeds — the parent's `key`
    // includes the table's STATUS, so a successful take-out-of-service remounts
    // this component and the panel goes with it. Closing here first meant a 409
    // or a network failure discarded the text the user had typed and made them
    // reopen the prompt and type it again.
    //
    // The key did not include status originally, and the claim that the parent
    // "unmounts this component on success" was simply false: the key was the
    // table id, unchanged by a status flip. The prompt re-rendered asking why a
    // table that was already out of service should be taken out of service, with
    // `busy` cleared and a second POST one tap away.
    onTakeOutOfService(table.id, trimmed)
  }

  // Seating a counter sale. Checked before everything, for the same reason merge
  // mode is: while it is active a card tap means "add this table", not "select".
  if (seating) {
    const count = seating.tableLabels.length
    return (
      <Shell
        label={`Seating ${seating.label}`}
        detail={
          count === 0
            ? 'Tap the table the guest moved to.'
            : `Moving to ${seating.tableLabels.join(' + ')}.`
        }
      >
        <button
          type="button"
          disabled={busy || count === 0}
          onClick={onConfirmSeating}
          className={primary}
        >
          {busy
            ? 'Seating…'
            : count === 0
              ? 'Seat'
              : `Seat at ${seating.tableLabels.join(' + ')}`}
        </button>
        <button type="button" onClick={onCancelSeating} className={secondary}>
          Cancel
        </button>
      </Shell>
    )
  }

  // Merge mode, checked first — while it is active the strip belongs to the
  // merge and nothing else, including the reason prompt.
  //
  // This is the ONE place a tap on a card changes meaning: it toggles a table
  // into the group instead of selecting it. That is exactly why the mode is
  // explicit, with a named anchor and Cancel/Done always visible. A tap that
  // sometimes selects and sometimes merges would put one party's items on
  // another party's bill.
  if (mergeTableIds && table) {
    const count = mergeTableIds.length
    // The anchor may ALREADY be a group — merging a fourth table into B1+B2+B3
    // is an ordinary thing to do. Naming only the primary would have the button
    // promise `Merge B1 + Table 5` for an action that actually produces a
    // four-table party, which is exactly the misstatement this button exists to
    // avoid.
    const anchorLabels = groupTables.length > 0 ? groupTables.map((t) => t.label) : [table.label]
    return (
      <Shell
        label={`Merging with ${mergedTitle(anchorLabels)}`}
        detail={
          count === 0
            ? 'Tap tables in this zone to add them.'
            : `${count} table${count === 1 ? '' : 's'} added. Tap to add or remove.`
        }
      >
        {/* The button states its consequence. `Done (2)` delegated the question
            "done doing what, to which tables?" to a confirmation dialog that
            would be read AFTER the decision; naming the tables here puts the
            answer at the moment of the tap, and costs nothing. See the story's
            note on why there is no confirm popup. */}
        <button
          type="button"
          disabled={busy || count === 0}
          onClick={onConfirmMerge}
          className={primary}
        >
          {busy ? 'Merging…' : mergeButtonLabel([...anchorLabels, ...mergeTableLabels])}
        </button>
        <button type="button" onClick={onCancelMerge} className={secondary}>
          Cancel
        </button>
      </Shell>
    )
  }

  // Which table is being released?
  //
  // This is a QUESTION, not a confirmation. With a merged group collapsed to one
  // card there is no longer a selected table to infer the target from, so the
  // panel exists because the information is genuinely missing — which is also
  // why it earns a step where a merge confirmation would not.
  //
  // The consequence line is the point of it. Nobody currently knows whether
  // un-merging takes the food with it; it does not, and staff assume it does.
  if (unmergeOpen && table && isMerged) {
    return (
      <Shell
        label="Release a table from this order?"
        detail="The table returns to the floor. Its items stay on the order."
      >
        <div className="flex flex-wrap items-center gap-sp-2">
          {groupTables.map((groupTable) => (
            <button
              key={groupTable.id}
              type="button"
              disabled={busy}
              onClick={() => {
                // Closed here, not left to the effect: releasing from a 3+ table
                // group leaves it a group, so `groupSize` stays above 1 and the
                // picker would otherwise still be open over the undo notice.
                setUnmergeOpen(false)
                onUnmerge(groupTable.id)
              }}
              className={secondary}
            >
              {groupTable.label}
            </button>
          ))}

          <button
            type="button"
            // Never disabled — same rule as the reason prompt's Cancel. Backing
            // out has to work even while a request is in flight.
            onClick={() => setUnmergeOpen(false)}
            className={secondary}
          >
            Cancel
          </button>
        </div>
      </Shell>
    )
  }

  // The reason prompt replaces the strip contents rather than opening a modal —
  // same shape as the walkout confirmation on the order screen. A POS does not
  // need a modal system for a four-option question.
  if (reasonOpen && table) {
    return (
      <Shell label={`Why is ${table.label} out of service?`} detail="Tap a reason, or type one.">
        <div className="flex flex-wrap items-center gap-sp-2">
          {QUICK_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              disabled={busy}
              onClick={() => submitReason(reason)}
              className={secondary}
            >
              {reason}
            </button>
          ))}

          <input
            type="text"
            value={customReason}
            maxLength={200}
            autoFocus
            disabled={busy}
            placeholder="Other…"
            aria-label="Other reason"
            onChange={(event) => setCustomReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitReason(customReason)
            }}
            className={cn(
              'h-touch-waiter w-48 rounded-waiter border border-slate-200 px-sp-3',
              'text-fs-16 text-slate-900 placeholder:text-slate-400',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          />

          <button
            type="button"
            disabled={busy || customReason.trim().length === 0}
            onClick={() => submitReason(customReason)}
            className={primary}
          >
            Take out of service
          </button>

          <button
            type="button"
            // Never disabled. Backing out must always work, and this was the one
            // control that stopped working during an in-flight request.
            onClick={() => {
              setReasonOpen(false)
              setCustomReason('')
            }}
            className={secondary}
          >
            Cancel
          </button>
        </div>
      </Shell>
    )
  }

  // A selected counter order. Checked before the table branches, since in the
  // Counter view there is no selected table at all.
  //
  // Its one action is "open the order" — a counter sale cannot be merged, taken
  // out of service, or seated from here. Closing lives on the order screen with
  // the walkout confirmation, exactly as it does for a table.
  if (counter) {
    const detail = [
      counter.elapsedMinutes !== undefined ? elapsed(counter.elapsedMinutes) : null,
      `${counter.itemCount} item${counter.itemCount === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Shell label={`${counter.label} · no table`} detail={detail}>
        {canSeat ? (
          <>
            {/* The guest moved from the bar to a table. Their order goes with
                them — same session, same items, same bill. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => onBeginSeating(counter.sessionId)}
              className={secondary}
            >
              Seat at table
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpenCounter(counter.sessionId)}
              className={primary}
            >
              Add items
            </button>
          </>
        ) : (
          <p className="text-fs-14 text-slate-600">Kitchen staff cannot open the order screen.</p>
        )}
      </Shell>
    )
  }

  if (!table) {
    // The Counter sale button used to live here. It moved to a pill in the zone
    // bar (Story 3.9, AC-1 amended): in a table-first system a lone button in
    // the strip's empty state read as a surface bolted on, while the zone bar is
    // already the control for "where am I looking" — and the counter is a place.
    return <Shell label="No table selected" detail="Tap a table to see what you can do with it." />
  }

  if (table.status === 'unavailable') {
    return (
      <Shell
        label={`${table.label} · out of service`}
        detail={table.unavailableReason ?? 'No reason recorded'}
      >
        {/* Owner only. The 403 from /api/config is the enforcement — hiding the
            button is courtesy, so a waiter is not offered something that will
            fail. */}
        {role === 'owner' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onReturnToService(table.id)}
            className={primary}
          >
            {busy ? 'Working…' : 'Return to service'}
          </button>
        ) : (
          <p className="text-fs-14 text-slate-600">Only an owner can return this table to service.</p>
        )}
      </Shell>
    )
  }

  if (table.status === 'occupied') {
    const groupLabels = groupTables.map((groupTable) => groupTable.label)
    const detail = [
      // The full list only when the title has had to truncate it. For a pair the
      // heading already reads `B2 + B3`, and repeating it underneath is noise.
      isMerged && groupTables.length > 2 ? groupLabels.join(' + ') : null,
      elapsedMinutes !== undefined ? elapsed(elapsedMinutes) : null,
      `${table.itemCount} item${table.itemCount === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Shell
        label={`${isMerged ? mergedTitle(groupLabels) : table.label} · occupied`}
        detail={detail}
      >
        {canSeat ? (
          <>
            {isMerged ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setUnmergeOpen(true)}
                className={secondary}
              >
                Un-merge
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={onBeginMerge} className={secondary}>
              Merge
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpenOrder(table.id)}
              className={primary}
            >
              Add items
            </button>
          </>
        ) : (
          <p className="text-fs-14 text-slate-600">Kitchen staff cannot open the order screen.</p>
        )}
      </Shell>
    )
  }

  if (!canSeat) {
    return (
      <Shell label={`${table.label} · ready to seat`} detail="Ready to seat">
        <p className="text-fs-14 text-slate-600">Kitchen staff cannot seat or hold tables.</p>
      </Shell>
    )
  }

  return (
    <Shell label={`${table.label} · no open order`} detail="Ready to seat">
      <button
        type="button"
        disabled={busy}
        onClick={() => setReasonOpen(true)}
        className={secondary}
      >
        Take out of service
      </button>
      {/* Pre-merge: stage the group BEFORE the order exists, so a party needing
          two tables is one session from the start rather than a merge after. */}
      <button type="button" disabled={busy} onClick={onBeginMerge} className={secondary}>
        Merge
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onStartOrder(table.id)}
        className={primary}
      >
        {busy ? 'Opening…' : 'Start order'}
      </button>
    </Shell>
  )
}

/**
 * `Merge B2 + B3`, and `Merge 4 tables` once naming them stops fitting a button.
 *
 * The cut-off is three because the button sits in a row beside Cancel on a
 * tablet in landscape; a fourth label pushes Cancel onto its own line, and the
 * control a waiter needs when they have staged the wrong table is the one that
 * must never move.
 */
function mergeButtonLabel(labels: string[]): string {
  if (labels.length <= 1) return 'Merge'
  if (labels.length <= 3) return `Merge ${labels.join(' + ')}`
  return `Merge ${labels.length} tables`
}

/**
 * This strip's chrome — the shared shell with the floor screen's own naming.
 *
 * The markup moved to `action-strip-chrome.tsx` in Story 4.1 so Epic 4's
 * OrderActionStrip could use it rather than copy it. Rendered output is
 * identical: same landmark name, same eyebrow, same classes.
 */
function Shell({
  label,
  detail,
  children,
}: {
  label: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <ActionStripShell regionLabel="Selected table actions" eyebrow="Selected" label={label} detail={detail}>
      {children}
    </ActionStripShell>
  )
}
