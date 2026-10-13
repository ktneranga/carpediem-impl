/**
 * Bill shapes shared by the service, the routes and the order screen
 * (Story 6.2, FR21/FR27).
 *
 * ── Every monetary field is an INTEGER PAISA ─────────────────────────────────
 * Never a float, never a formatted string. `lkrFromPaisa` is for rendering and
 * runs in the component, so one value cannot reach the client already rounded
 * to rupees and then be added to another.
 */

/** The four amounts and the two rates that produced them. */
export type BillTotals = {
  subtotalPaisa: number
  serviceChargePaisa: number
  taxPaisa: number
  totalPaisa: number
  /**
   * The service rate APPLIED, in basis points (1000 = 10.00%).
   *
   * `0` on a bill with no table service, even when the tenant's configured
   * rate is higher — the bill records what it charged, not what was configured.
   */
  serviceChargeBp: number
  /** The tax rate applied, in basis points. */
  taxBp: number
}

/** One billed item, priced as it was quoted when it was sent. */
export type BillLineDetail = {
  orderEventId: string
  name: string
  quantity: number
  /** From the event row, NOT the menu — a re-price must not move a live bill. */
  unitPricePaisa: number
  /** quantity × unitPricePaisa. */
  amountPaisa: number
  /** Null for an event with no seat — a counter sale. */
  seatLabel: string | null
  modifierText: string | null
  roundNumber: number | null
}

/** A comp on a bill: a NEGATIVE amount with the reason it was given. */
export type BillCompDetail = {
  compRecordId: string
  /** Negative paisa — it reduces the subtotal. */
  amountPaisa: number
  reason: string
}

/** A whole bill, as the API returns it. */
export type BillDetail = BillTotals & {
  billId: string
  sessionId: string
  type: 'consolidated' | 'seat'
  /** The seat this bill covers, or null for a consolidated bill (Story 6.4). */
  seatSlotId: string | null
  /**
   * That seat's label, taken from the SNAPSHOTTED `bill_lines.seat_label` —
   * never from a live `seat_slots` join, which migration 0019 removed.
   *
   * The seat NOTE ("red shirt", "bald man") must never appear here or anywhere
   * else on a guest-facing bill. Teran's decision, 2026-09-12.
   */
  seatLabel: string | null
  createdAt: string
  lines: BillLineDetail[]
  comps: BillCompDetail[]
}
