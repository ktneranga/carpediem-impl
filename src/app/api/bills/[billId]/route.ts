import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { getBill } from '@/server/services/bill.service'

const billIdSchema = z.string().uuid()

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * One bill with everything FR27 says it must itemise (Story 6.2, AC-4).
 *
 * Read from the stored lines and the stored rates — never recomputed from the
 * session. A bill printed at 19:40 must render identically at 21:00 after the
 * kitchen re-priced a dish, which is the whole reason `bill_lines` and the two
 * `_bp` columns exist.
 *
 * Every monetary field is an integer paisa (AC-8); formatting is the
 * component's job.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ billId: string }> },
) {
  const { billId: rawBillId } = await params

  const parsedBillId = billIdSchema.safeParse(rawBillId)
  if (!parsedBillId.success) {
    return fail('INVALID_BILL_ID', 'Bill id must be a UUID', 400)
  }

  try {
    const bill = await getBill(db, parsedBillId.data)
    if (!bill) {
      return fail('BILL_NOT_FOUND', 'No such bill', 404)
    }
    return NextResponse.json({ success: true, data: bill }, { status: 200 })
  } catch (error) {
    console.error('[api/bills/:billId] Failed to read bill:', error)
    return fail('INTERNAL_ERROR', 'Could not load the bill', 500)
  }
}
