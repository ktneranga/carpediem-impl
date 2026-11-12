import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import {
  CompsExceedOrderError,
  ItemsNotBillableError,
  MissingTenantConfigError,
  NothingToBillError,
  UnpricedItemError,
} from '@/server/services/bill.service'
import { BillTotalChangedError, printDraft } from '@/server/services/receipt.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()

/**
 * What to print before anything is billed: nothing (the whole unbilled table)
 * or one person's share — event ids and unit counts, never prices. The name
 * is optional and only a neutral one is printed (`guestBillLabel`).
 *
 * `safeParse`, never `.catch()`: a malformed share must be refused, not
 * quietly printed as the whole table.
 */
const bodySchema = z.object({
  items: z
    .array(z.object({ eventId: z.string().uuid(), quantity: z.number().int().positive().max(99) }))
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((item) => item.eventId)).size === items.length, {
      message: 'Each item once',
    })
    .optional(),
  personLabel: z.string().max(60).nullable().optional(),
  /** What the waiter's screen showed; a different total is refused (409). */
  expectedTotalPaisa: z.number().int().nonnegative().optional(),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Prints what a table owes before it is billed (Story 6.6, FR69).
 *
 * Writes no bill: the waiter can print, hand it over, and still add a dessert.
 * Priced on the server by the same code Settle uses. RBAC is the
 * `/api/sessions` prefix (owner + waiter).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params
  const parsedId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedId.success) return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)

  if (!request.headers.get('x-staff-id')) return fail('UNAUTHENTICATED', 'Sign in required', 401)

  let body: unknown = {}
  const text = await request.text()
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      return fail('INVALID_BODY', 'Request body must be JSON', 400)
    }
  }
  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success) return fail('INVALID_BODY', 'Items must be event ids with whole unit counts', 400)

  try {
    const result = await db.transaction((tx) =>
      printDraft(tx, {
        sessionId: parsedId.data,
        items: parsedBody.data.items,
        personLabel: parsedBody.data.personLabel,
        expectedTotalPaisa: parsedBody.data.expectedTotalPaisa,
        staffId: request.headers.get('x-staff-id'),
      }),
    )
    return NextResponse.json({ success: true, data: result }, { status: 202 })
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is already closed', 409)
    }
    if (error instanceof ItemsNotBillableError) {
      return fail('ITEMS_NOT_BILLABLE', 'Some of these items are already on another bill. Refresh and try again.', 409)
    }
    if (error instanceof BillTotalChangedError) {
      return fail('BILL_CHANGED', 'The bill changed since this screen loaded. Refresh and print again.', 409)
    }
    if (error instanceof NothingToBillError) {
      return fail('NOTHING_TO_BILL', 'There is nothing left to bill on this order', 422)
    }
    if (error instanceof UnpricedItemError) {
      return fail('UNPRICED_ITEM', 'An item on this order has no price recorded', 422)
    }
    if (error instanceof CompsExceedOrderError) {
      return fail('COMPS_EXCEED_ORDER', 'The discounts on this order are larger than what is left to bill', 422)
    }
    if (error instanceof MissingTenantConfigError) {
      console.error('[api/sessions/:sessionId/bill-print] No tenant_config row for this tenant')
      return fail('INTERNAL_ERROR', 'The restaurant is not configured for billing', 500)
    }
    console.error('[api/sessions/:sessionId/bill-print] Failed to queue the bill:', error)
    return fail('INTERNAL_ERROR', 'Could not send the bill to the printer', 500)
  }
}
