import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isProvisioned, markProvisioned } from '@/server/services/setup-state'
import { AlreadySetUpError, runSetup, SetupFieldError } from '@/server/services/setup.service'

/**
 * First-run setup (spec-first-run-setup). Public in the proxy, and refused once
 * a restaurant exists. The PIN and password are never echoed: a bad body names
 * the field, never its value.
 */
const bodySchema = z.object({
  restaurantName: z.string().max(200),
  timeZone: z.string().max(100),
  ownerName: z.string().max(200),
  pin: z.string().max(10),
  managePassword: z.string().max(200),
})

function fail(code: string, message: string, status: number, field?: string) {
  return NextResponse.json({ success: false, error: { code, message, ...(field ? { field } : {}) } }, { status })
}

export async function POST(request: Request) {
  // JSON only: a plain-text cross-site POST from another web page cannot
  // claim a fresh install (browsers send JSON only after a CORS preflight).
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return fail('INVALID_BODY', 'Request body must be JSON', 415)
  }
  // Set up already: refuse before any bcrypt work, so this public route costs
  // nothing on a live POS.
  try {
    if (await isProvisioned()) return fail('ALREADY_SET_UP', 'This system is already set up. Sign in with your PIN.', 409)
  } catch (error) {
    console.error('[api/setup] Could not check the install:', error)
    return fail('INTERNAL_ERROR', 'The database is not reachable', 503)
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '')
    return fail('INVALID_BODY', 'Fill in every field', 400, field || undefined)
  }

  try {
    const result = await runSetup(parsed.data)
    markProvisioned()
    return NextResponse.json({ success: true, data: { tenantId: result.tenantId } }, { status: 201 })
  } catch (error) {
    if (error instanceof AlreadySetUpError) return fail('ALREADY_SET_UP', error.message, 409)
    if (error instanceof SetupFieldError) return fail('INVALID', error.message, 422, error.field)
    console.error('[api/setup] Setup failed:', error)
    return fail('INTERNAL_ERROR', 'Could not set up the restaurant', 500)
  }
}
