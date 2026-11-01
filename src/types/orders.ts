/**
 * Order types shared by the server and the order screen.
 *
 * Here, not in `src/server/`, because `architecture.md` states that components
 * never import from `src/server/`. Story 4.4's review left two components
 * importing these from `src/server/orders/submitted-rounds` — type-only and
 * erased at build, but the boundary is a rule, not a runtime accident.
 *
 * It imports nothing. It used to take `MenuItemRow` from `@/app/api/menu/route`
 * to derive the destination union, which pulled a route handler — and through
 * it `server-only` — into the module written to keep the two apart.
 */

/**
 * A priced option on a menu item — "Extra shot", +LKR 1,000 (Story 4.8, FR65).
 *
 * `priceDeltaPaisa` may be negative ("No alcohol", −LKR 1,000) or 0 ("No ice").
 */
export type ModifierOptionRow = {
  id: string
  name: string
  priceDeltaPaisa: number
  /** Preselected when the dish is added with one tap. */
  isDefault: boolean
  /**
   * How many times one line may take it: 1 for on/off, more for a countable
   * option ("Extra shot" ×3). Chosen N times = its id N times in `optionIds`.
   */
  maxCount: number
  /** A group on the same item that choosing this rules out ("No alcohol" → "Extra shots"). */
  excludesGroupId: string | null
  /** An unavailable option is shown disabled and refused by the server. */
  available: boolean
}

/** A group of options on one menu item — "Alcohol", "Ice". */
export type ModifierGroupRow = {
  id: string
  name: string
  /** `single`: at most one option. `multi`: any number. */
  selection: 'single' | 'multi'
  /** A required group must have a choice before the dish can be sent. */
  required: boolean
  options: ModifierOptionRow[]
}

/**
 * The options a SENT item was ordered with, frozen on its order event
 * (`order_events.options`). Copied at send and never re-read from the menu, so
 * renaming, re-pricing or retiring an option never rewrites a sent line, a
 * ticket or a bill. No foreign keys: history must not block retiring an option.
 */
export type OrderEventOption = {
  optionId: string
  group: string
  name: string
  /** PER UNIT. The line paid `priceDeltaPaisa × count`. */
  priceDeltaPaisa: number
  /** How many were taken — "Extra shot" ×3. Absent on early snapshots: 1. */
  count?: number
}

/** One submitted item, as the history renders it. */
export type SubmittedItemRow = {
  id: string
  name: string
  quantity: number
  /** Integer paisa, AS QUOTED — read from the event row, never from the menu. */
  unitPricePaisa: number | null
  modifierText: string | null
  /** The chosen options' names, "Extra shot ×2, No ice" — null when none (Story 4.8). */
  optionText: string | null
  seatLabel: string | null
  submittedAt: string
}

/** One round of a session's ordering, oldest first. */
export type SubmittedRoundRow = {
  roundNumber: number
  items: SubmittedItemRow[]
}

/** FR9's three destinations. Mirrors `production_destination` in the schema. */
export type ProductionDestination = 'kitchen' | 'pizza_kitchen' | 'bar'

/** Limits on one send. Shared so the client can refuse before the server does. */
export const MAX_ROUND_LINES = 100
export const MAX_LINE_QUANTITY = 99
export const MAX_MODIFIER_TEXT = 120
/**
 * Option ids on one line — a countable option sends its id once per unit, so
 * this sits well above a few countable options at their cap (`max_count` ≤
 * 10, a database CHECK). A cap on a malformed body, not on a real dish.
 */
export const MAX_OPTIONS_PER_LINE = 40

/** One staged line, as sent to `POST /api/sessions/:sessionId/orders`. */
export type SubmitRoundLine = {
  menuItemId: string
  seatSlotId: string
  /** 1..MAX_LINE_QUANTITY */
  quantity: number
  /** "" for none. Trimmed on the server; "" is stored as null. */
  modifierText: string
  /**
   * The chosen options (Story 4.8). Optional on the wire — the server defaults
   * it to [] — so older tablets and rounds mirrored before 4.8 still send.
   */
  optionIds?: string[]
  /**
   * The UNIT price the waiter SAW, in paisa: the dish plus its options, never
   * below zero (`unitPriceFor`). A check, never a value: the server computes the
   * same price from the menu and refuses if this differs (AC-9, Story 4.8).
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
  /** An option unknown, foreign, unavailable, repeated, too many, or a required group empty. */
  | 'OPTION_INVALID'

/** One line of a production ticket, as the `order:submitted` event carries it. */
export type TicketLine = {
  eventId: string
  name: string
  quantity: number
  modifierText: string | null
  /**
   * The chosen options' names, printed under the dish (Story 4.8). OPTIONAL:
   * print jobs queued before 4.8 are stored without it and must still print.
   */
  options?: string[]
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
  /**
   * Dishes in THIS ROUND — not the session's total.
   *
   * Named apart from `table:status_changed`'s `itemCount`, which is the whole
   * session's. The two were emitted in adjacent lines with the same name.
   */
  roundItemCount: number
}
