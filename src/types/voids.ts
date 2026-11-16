/**
 * Voids and bill cancellations (Story 7.5), shared by the sheets, the routes
 * and the service. Imports nothing, like the other modules in `src/types`.
 */

/** Why a sent item is voided. "Other" needs a note. */
export const VOID_REASONS = ['Entered by mistake', 'Guest changed mind', "Kitchen can't make it", 'Other'] as const
export type VoidReason = (typeof VOID_REASONS)[number]

/** Why an unpaid bill is cancelled. "Other" needs a note. */
export const BILL_CANCEL_REASONS = ['Wrong item on it', 'Guest wants it split differently', 'Other'] as const
export type BillCancelReason = (typeof BILL_CANCEL_REASONS)[number]

/** Why a whole order is cancelled (Teran, 2026-11-16). "Other" needs a note. */
export const ORDER_CANCEL_REASONS = ['Guest left before the food', 'Wrong table', 'Guest changed mind', 'Other'] as const

export const MAX_VOID_NOTE = 120

/** What the audit trail stores in `notes` / `cancel_reason`: the reason, and the note when given. */
export function reasonText(reason: string, note: string | null | undefined): string {
  const trimmed = note?.trim() ?? ''
  if (reason === 'Other') return trimmed
  return trimmed ? `${reason} — ${trimmed}` : reason
}

export type VoidResult = {
  voidId: string
  quantity: number
  /** A dish (not a custom charge): the kitchen or bar should hear about it. */
  ticketNeeded: boolean
  /** The VOID ticket is on the print queue. False with `ticketNeeded`: tell the kitchen. */
  ticketQueued: boolean
}
