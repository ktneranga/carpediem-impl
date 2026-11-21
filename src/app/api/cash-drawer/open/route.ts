import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { type StaffRole } from '@/server/auth/permissions'
import { CASH_IN_REASONS, CASH_OUT_REASONS, openWithoutSale } from '@/server/services/cash-drawer.service'
import { wakePrintQueue } from '@/server/print/wake'

/**
 * Why the drawer is opened. `other` needs a note; the database checks it too
 * (`cash_drawer_openings_note`). `safeParse`: a malformed request is refused,
 * never quietly opened as something else.
 */
const bodySchema = z
  .object({
    reason: z.enum(['change', 'float', 'other', 'pay_in', 'paid_out', 'cash_drop']),
    /** Positive paisa, for a cash in or out (Teran, 2026-11-16). */
    amountPaisa: z.number().int().positive().max(100_000_000).nullable().optional(),
    /** Other only: whether the amount went into the drawer or out of it. */
    direction: z.enum(['in', 'out']).nullable().optional(),
    note: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((note) => (note ? note : null)),
  })
  .refine((body) => !['other', 'paid_out', 'cash_drop'].includes(body.reason) || body.note !== null, {
    message: 'Say why the drawer is being opened',
    path: ['note'],
  })
  .refine(
    (body) =>
      [...CASH_IN_REASONS, ...CASH_OUT_REASONS].includes(body.reason)
        ? typeof body.amountPaisa === 'number'
        : body.reason === 'other'
          ? // Other: optional amount, and a direction exactly when there is one.
            (body.amountPaisa == null) === (body.direction == null)
          : body.amountPaisa == null,
    { message: 'Enter the amount', path: ['amountPaisa'] },
  )

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Opens the cash drawer with no sale (Story 6.7, FR72).
 *
 * Owner only: the `/api/cash-drawer` entry in `ROUTE_ROLES` refuses everyone
 * else before this runs, and the role is checked again here so the two
 * cannot drift. Queues the kick and records who and why in one transaction;
 * 202 because what was created is a request to the printer.
 */
export async function POST(request: Request) {
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)
  const role = request.headers.get('x-staff-role') as StaffRole | null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    return fail(
      'INVALID_BODY',
      field === 'note'
        ? 'Say why (up to 120 characters)'
        : field === 'amountPaisa'
          ? 'Enter the amount'
          : 'Choose a reason',
      400,
    )
  }

  // Only the owner opens the drawer by hand, for any reason (Teran,
  // 2026-11-21). `ROUTE_ROLES` refuses everyone else first; this says it again
  // so the two cannot drift. A cash payment still kicks the drawer itself.
  if (role !== 'owner') return fail('FORBIDDEN', 'Only the owner can open the cash drawer', 403)
  const reason = parsed.data.reason

  try {
    const [member] = await db.select({ tenantId: staff.tenantId }).from(staff).where(eq(staff.id, staffId)).limit(1)
    if (!member) return fail('UNAUTHENTICATED', 'Sign in required', 401)

    const result = await db.transaction((tx) =>
      openWithoutSale(tx, {
        tenantId: member.tenantId,
        staffId,
        reason,
        note: parsed.data.note,
        amountPaisa: parsed.data.amountPaisa ?? null,
        direction: parsed.data.direction ?? null,
      }),
    )
    wakePrintQueue()
    return NextResponse.json({ success: true, data: result }, { status: 202 })
  } catch (error) {
    console.error('[api/cash-drawer/open] Failed to queue the drawer:', error)
    return fail('INTERNAL_ERROR', 'Could not open the drawer', 500)
  }
}
