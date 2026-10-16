'use client'

import { useState } from 'react'
import { Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'

import {
  ActionStripShell,
  primaryButtonClass,
  secondaryButtonClass,
  sendButtonClass,
  MoreMenu,
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
 * that strip, and renaming to match it would orphan four stories.
 *
 * ── The buttons sit on one row (2026-09-20, Teran's mockup) ──────────────────
 * Send used to take a full-width row of its own, per `ux-design-specification.md`
 * :899. It is now the last control on the button row, made primary by width and
 * weight rather than by a row — see `sendButtonClass` for what that trades and
 * why. Hold and Bill & split, which the mockup also draws, are still not
 * rendered: neither does anything yet, and the strip draws no button without a
 * handler (both logged in `deferred-work.md`).
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
  /**
   * Where the staged items will go — "Kitchen", "Kitchen & Bar". Shown beside
   * the count so the waiter knows which tickets a send will print before they
   * send it (FR9). Assembled by the caller, which owns the staged lines.
   */
  destinationSummary?: string
  /**
   * Why the round cannot be sent right now, or what happened to the last send —
   * shown in place of the destination line, in the region screen readers
   * announce. When `sendBlocked` is true the Send button stays but is disabled,
   * with this text saying why: a Send that silently does nothing is worse.
   */
  note?: string
  sendBlocked?: boolean
  busy?: boolean
  onSubmitOrder?: () => void
  /**
   * Items for the "More" menu (2026-10-16 design).
   *
   * The destructive actions live here rather than on the row: "Clear unsent
   * items" throws away a round the waiter has just typed, and "Close table —
   * walkout" ends the sitting. Both were one tap from Send, at the same size.
   *
   * Passed as data rather than as buttons so the strip keeps deciding its own
   * layout — the same reason `onClear` is a callback and not a node.
   */
  moreItems?: { label: string; onClick: () => void; danger?: boolean }[]
  onClear?: () => void
  onAddMoreItems?: () => void
  onGenerateBill?: () => void
}

export function OrderActionStrip({
  state,
  stagedCount = 0,
  destinationSummary,
  note,
  sendBlocked = false,
  busy = false,
  onSubmitOrder,
  moreItems = [],
  onClear,
  onAddMoreItems,
  onGenerateBill,
}: OrderActionStripProps) {
  const [moreOpen, setMoreOpen] = useState(false)
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
        {onAddMoreItems ? (
          <button type="button" onClick={onAddMoreItems} className={secondaryButtonClass}>
            Add More Items
          </button>
        ) : null}
        {/* Only with a handler. This rendered unconditionally, so the order
            screen — which has no billing until Epic 6 — showed an enabled
            "Generate Bill" that did nothing: the same dead control the commit
            button below had, found while fixing that one's twin. */}
        {onGenerateBill ? (
          <button
            type="button"
            disabled={busy}
            onClick={onGenerateBill}
            className={primaryButtonClass}
          >
            Generate Bill
          </button>
        ) : null}
      </ActionStripShell>
    )
  }

  // Items are staged and nothing has left for the kitchen yet.
  //
  // Send is the LAST control on the row, and the only solid brand fill on it. It
  // is the one action in the order flow that reaches production and cannot be
  // quietly taken back, so it has to be the thing the eye lands on — which is
  // now width, weight and position rather than a row of its own.
  //
  // `stagedCount` can legitimately be 0 here — the parent owns the state and a
  // round can be opened before anything is added — so the label says so rather
  // than reading "0 items staged", and the commit stays disabled until there is
  // something to send.
  if (state === 'items-added') {
    return (
      <ActionStripShell
        regionLabel="Order actions"
        // "Not sent" is the eyebrow because it is the one fact that must never
        // be misread on this screen: the kitchen does not have these yet.
        eyebrow="Not sent"
        label={
          stagedCount === 0
            ? 'Nothing staged yet'
            : `${stagedCount} item${stagedCount === 1 ? '' : 's'}`
        }
        detail={
          note ?? (destinationSummary ? `→ ${destinationSummary}` : 'Nothing has gone to the kitchen yet.')
        }
      >
        {moreItems.length > 0 ? (
          <MoreMenu
            busy={busy}
            open={moreOpen}
            onOpenChange={setMoreOpen}
            items={moreItems}
          />
        ) : null}
        {onClear ? (
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
        ) : null}
        {/* No handler, no button. This used to render unconditionally with
            `onClick={onSubmitOrder}`, so a caller that had not wired submission
            yet got a fully enabled "Submit Order" that silently did nothing on
            tap. That is the dead-control defect this file's own header argues
            against ("NO buttons at all, never disabled ones: a disabled control
            invites a tap and teaches nothing") — and an undefined handler
            produced the same thing a no-op would have.

            Story 4.4 stages items without wiring submission; 4.5 passes the
            handler and Send appears. */}
        {/* "Bill & split" sits beside Send while items are still staged, as
            the design draws it. It generates the bill; the SPLIT half of the
            name is Stories 6.1/6.3 and the screen it should open does not
            exist yet, so for now this is the same action the `submitted`
            state offers, in the position the design puts it. */}
        {onGenerateBill ? (
          <button
            type="button"
            disabled={busy}
            onClick={onGenerateBill}
            className={cn(
              'flex h-touch-waiter items-center gap-sp-2 rounded-waiter px-sp-5',
              'border border-brand-500 bg-brand-050 text-fs-16 font-bold text-brand-800',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed disabled:opacity-40',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <Receipt aria-hidden="true" strokeWidth={2.2} className="size-5 shrink-0" />
            Bill &amp; split
          </button>
        ) : null}
        {onSubmitOrder ? (
          <button
            type="button"
            disabled={busy || sendBlocked || stagedCount === 0}
            onClick={onSubmitOrder}
            className={sendButtonClass}
          >
            {busy ? (
              'Sending…'
            ) : (
              // Two lines, as the design draws it: the COUNT is the decision
              // and the stations are the consequence. On one line the
              // stations pushed the count off-centre on a long routing
              // ("Send 3 to Kitchen + Pizza + Bar").
              <span className="flex flex-col items-center leading-tight">
                <span>
                  Send {stagedCount} item{stagedCount === 1 ? '' : 's'}
                </span>
                <span className="text-fs-12 font-semibold opacity-90">
                  to {destinationSummary ?? 'the kitchen'}
                </span>
              </span>
            )}
          </button>
        ) : null}
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
