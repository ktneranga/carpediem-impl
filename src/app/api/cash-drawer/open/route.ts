import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { canOpenCashDrawer, parsePermissionsHeader, type StaffRole } from '@/server/auth/permissions'
import { openWithoutSale } from '@/server/services/cash-drawer.service'
import { wakePrintQueue } from '@/server/print/wake'

/**
 * Why the drawer is opened. `other` needs a note; the database checks it too
 * (`cash_drawer_openings_note`). `safeParse`: a malformed request is refused,
 * never quietly opened as something else.
 */
const bodySchema = z
  .object({
    reason: z.enum(['change', 'float', 'other']),
    note: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((note) => (note ? note : null)),
  })
  .refine((body) => body.reason !== 'other' || body.note !== null, {
    message: 'Say why the drawer is being opened',
    path: ['note'],
  })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Opens the cash drawer with no sale (Story 6.7, FR72).
 *
 * Owner only: the `/api/cash-drawer` entry in `ROUTE_ROLES` refuses everyone
 * else before this runs, and `canOpenCashDrawer` is asked again here so the two
 * cannot drift. Queues the kick and records who and why in one transaction;
 * 202 because what was created is a request to the printer.
 */
export async function POST(request: Request) {
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)
  if (
    !canOpenCashDrawer(
      request.headers.get('x-staff-role') as StaffRole | null,
      parsePermissionsHeader(request.headers.get('x-staff-permissions')),
    )
  ) {
    return fail('FORBIDDEN', 'You are not allowed to open the drawer without a sale', 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    const noteMissing = parsed.error.issues.some((issue) => issue.path[0] === 'note')
    return fail(
      'INVALID_BODY',
      noteMissing ? 'Say why the drawer is being opened (up to 120 characters)' : 'Choose Change, Float or Other',
      400,
    )
  }

  try {
    const [member] = await db.select({ tenantId: staff.tenantId }).from(staff).where(eq(staff.id, staffId)).limit(1)
    if (!member) return fail('UNAUTHENTICATED', 'Sign in required', 401)

    const result = await db.transaction((tx) =>
      openWithoutSale(tx, { tenantId: member.tenantId, staffId, reason: parsed.data.reason, note: parsed.data.note }),
    )
    wakePrintQueue()
    return NextResponse.json({ success: true, data: result }, { status: 202 })
  } catch (error) {
    console.error('[api/cash-drawer/open] Failed to queue the drawer:', error)
    return fail('INTERNAL_ERROR', 'Could not open the drawer', 500)
  }
}
