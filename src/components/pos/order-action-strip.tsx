'use client'

import {
  ActionStripShell,
  commitButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/components/pos/action-strip-chrome'

/**
 * The order screen's state-driven action bar (UX-DR7).
 *
 * ── What it is not ───────────────────────────────────────────────────────────
 * NOT `FloorActionStrip`. That one is driven by TABLE state on the floor plan —
 * open, occupied, unavailable, plus merge and seating modes. This one is driven
 * by an ORDER ROUND's lifecycle and knows nothing about tables at all. They share
 * their chrome (`action-strip-chrome.tsx`) and nothing else; see the note there
 * for why merging them would be a mistake.
 *
 * That it names no table is load-bearing, not incidental: a counter sale (FR64)
 * reaches this screen with no table, no zone and no label, and every part of the
 * order flow must work identically for it.
 *
 * ── State vocabulary ─────────────────────────────────────────────────────────
 * The five names below come from `epics.md`, and Stories 4.4, 4.5, 6.2 and 6.4
 * all reference them and the button labels by name. `ux-design-specification.md`
 * :887 gives a different six-row table indexed by TABLE state — it predates the
 * floor strip, its first two rows ("New Order", "Start Order") now belong to
 * that strip, and renaming to match it would orphan four stories. The one thing
 * kept verbatim from the spec is the full-width commit; see `commitButtonClass`.
 *
 * ── Pure presentation ────────────────────────────────────────────────────────
 * No fetching, no mutation, no router. Every action is a callback handed down.
 * The floor strip owns no data either, and that is why it survived three reviews
 * with its logic intact while everything around it changed.
 */

export type OrderActionStripState =
  | 'empty'
  | 'items-added'
  | 'submitted'
  | 'settling'
  | 'closed'

export type OrderActionStripProps = {
  state: OrderActionStripState
  /** Items staged in the CURRENT round — not the session total. */
  stagedCount?: number
  busy?: boolean
  onSubmitOrder?: () => void
  onClear?: () => void
  onAddMoreItems?: () => void
  onGenerateBill?: () => void
}

export function OrderActionStrip({
  state,
  stagedCount = 0,
  busy = false,
  onSubmitOrder,
  onClear,
  onAddMoreItems,
  onGenerateBill,
}: OrderActionStripProps) {
  // Terminal. No buttons at all — not disabled ones, which invite a tap and
  // teach nothing — and a muted shell so it reads as finished rather than as an
  // order waiting for input.
  //
  // Unreachable through the app today: `/orders/:sessionId` inner-joins on an
  // OPEN session and redirects to the floor when there is none, so a closed
  // session never renders this screen. Built because the AC asks for it and
  // Epic 6 may show a settled summary.
  if (state === 'closed') {
    return (
      <ActionStripShell
        regionLabel="Order actions"
        eyebrow="Order"
        label="Session closed"
        detail="This order is settled. Nothing further can be added."
        muted
      />
    )
  }

  // Settlement has started and the round is no longer the thing being worked on.
  // Epic 6 owns what replaces these actions; until then the strip's job is to
  // say plainly that order entry is over, rather than offering buttons that
  // would write to a session being billed.
  if (state === 'settling') {
    return (
      <ActionStripShell
        regionLabel="Order actions"
        eyebrow="Order"
        label="Settling"
        detail="The bill is being prepared. Items cannot be added or changed."
      />
    )
  }

  // The round reached production. Submit is gone — deliberately, not disabled:
  // the round it referred to no longer exists, and a greyed Submit invites the
  // waiter to wonder what happened to it.
  if (state === 'submitted') {
    return (
      <ActionStripShell
        regionLabel="Order actions"
        eyebrow="Order"
        label="Order sent"
        detail="Sent to the kitchen. Add another round, or generate the bill."
      >
        {/* NOT disabled by `busy`. Opening a new round is local and harmless,
            and it is the only way out if a Generate Bill request hangs — the
            same rule that keeps Clear reachable in `items-added`, which was
            written after the floor strip's review found a Cancel that stopped
            working mid-request. */}
        <button type="button" onClick={onAddMoreItems} className={secondaryButtonClass}>
          Add More Items
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onGenerateBill}
          className={primaryButtonClass}
        >
          Generate Bill
        </button>
      </ActionStripShell>
    )
  }

  // Items are staged and nothing has left for the kitchen yet.
  //
  // Submit goes in the shell's `commit` slot, which renders it as a direct flex
  // item on its own full-width row. It is the one action in the order flow that
  // reaches production and cannot be quietly taken back, and the UX spec calls
  // it "the single unmissable primary action".
  //
  // `stagedCount` can legitimately be 0 here — the parent owns the state and a
  // round can be opened before anything is added — so the label says so rather
  // than reading "0 items staged", and the commit stays disabled until there is
  // something to send.
  if (state === 'items-added') {
    return (
      <ActionStripShell
        regionLabel="Order actions"
        eyebrow="Order"
        label={
          stagedCount === 0
            ? 'Nothing staged yet'
            : `${stagedCount} item${stagedCount === 1 ? '' : 's'} staged`
        }
        detail="Nothing has gone to the kitchen yet."
        // The SLOT, not a `w-full` child of the button row. See ActionStripShell.
        commit={
          <button
            type="button"
            disabled={busy || stagedCount === 0}
            onClick={onSubmitOrder}
            className={commitButtonClass}
          >
            {busy ? 'Sending…' : 'Submit Order'}
          </button>
        }
      >
        <button
          type="button"
          // Never disabled by `busy`. Backing out has to work even while a
          // request is in flight — the rule the floor strip's Cancel controls
          // established after its review found one that stopped working.
          onClick={onClear}
          className={secondaryButtonClass}
        >
          Clear
        </button>
      </ActionStripShell>
    )
  }

  // Nothing staged. No action is offered, but the strip still occupies its
  // space: it must not appear when the first item is added, or the menu above
  // would shift under the waiter's finger at exactly the wrong moment.
  return (
    <ActionStripShell
      regionLabel="Order actions"
      eyebrow="Order"
      label="Add items to begin"
      detail="Nothing staged yet."
    />
  )
}
