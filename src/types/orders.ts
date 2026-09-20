/**
 * Order types shared by the server and the order screen.
 *
 * Here, not in `src/server/`, because `architecture.md` states that components
 * never import from `src/server/`. Story 4.4's review left two components
 * importing these from `src/server/orders/submitted-rounds` — type-only and
 * erased at build, but the boundary is a rule, not a runtime accident.
 */

import type { MenuItemRow } from '@/app/api/menu/route'

/** One submitted item, as the history renders it. */
export type SubmittedItemRow = {
  id: string
  name: string
  quantity: number
  /** Integer paisa, AS QUOTED — read from the event row, never from the menu. */
  unitPricePaisa: number | null
  modifierText: string | null
  seatLabel: string | null
  submittedAt: string
}

/** One round of a session's ordering, oldest first. */
export type SubmittedRoundRow = {
  roundNumber: number
  items: SubmittedItemRow[]
}

export type ProductionDestination = MenuItemRow['productionDestination']

/** Limits on one send. Shared so the client can refuse before the server does. */
export const MAX_ROUND_LINES = 100
export const MAX_LINE_QUANTITY = 99
export const MAX_MODIFIER_TEXT = 120

/** One staged line, as sent to `POST /api/sessions/:sessionId/orders`. */
export type SubmitRoundLine = {
  menuItemId: string
  seatSlotId: string
  /** 1..MAX_LINE_QUANTITY */
  quantity: number
  /** "" for none. Trimmed on the server; "" is stored as null. */
  modifierText: string
  /**
   * The price the waiter SAW, in paisa. A check, never a value: the server
   * writes the menu's current price and refuses if this differs (AC-9).
   */
  quotedPricePaisa: number
}

export type SubmitRoundRequest = {
  /** Client-generated, stable across retries of the same round (AC-8, AC-13). */
  submissionId: string
  lines: SubmitRoundLine[]
}

export type SubmitRoundResponse = {
  submissionId: string
  roundNumber: number
  /** Dishes in the round — the sum of quantities. */
  itemCount: number
  /** True when this submissionId had already been committed; nothing new was written. */
  replayed: boolean
}

/** Error codes the send can return, beyond the generic ones. */
export type SubmitRoundErrorCode =
  | 'ITEM_UNAVAILABLE'
  | 'SEAT_NOT_FOUND'
  | 'PRICE_CHANGED'
  | 'SESSION_ALREADY_CLOSED'
  | 'SUBMISSION_ID_REUSED'
  | 'ROUND_CONFLICT'

/** One line of a production ticket, as the `order:submitted` event carries it. */
export type TicketLine = {
  eventId: string
  name: string
  quantity: number
  modifierText: string | null
  seatLabel: string
  /**
   * "red shirt" — ON the kitchen ticket by design (Story 4.3 AC-11): it is how
   * the runner hands the plate to the right person. Never on a guest's bill.
   */
  seatNote: string | null
}

/** `order:submitted`, sent to one production room per destination present. */
export type OrderSubmittedPayload = {
  eventId: string
  timestamp: string
  staffId: string
  sessionId: string
  roundNumber: number
  destination: ProductionDestination
  /** Every table on the session, in label order. Empty for a counter sale. */
  tableLabels: string[]
  /** False outside the Tables zone: print no seat headers. */
  usesSeats: boolean
  lines: TicketLine[]
}

/** `order:confirmed`, sent to the session's room. */
export type OrderConfirmedPayload = {
  eventId: string
  timestamp: string
  staffId: string
  sessionId: string
  roundNumber: number
  itemCount: number
}
