import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  MAX_SECRET_LENGTH,
  checkVendorPassword,
  installationTenant,
  startVendorSession,
  VENDOR_COOKIE_NAME,
  vendorCookieOptions,
} from '@/server/services/vendor.service'

/**
 * Vendor sign-in (spec-11-1-vendor-access-export). Public in the proxy: the
 * password is the credential. The password is never echoed or logged — a bad
 * body names no field.
 */
const bodySchema = z.object({ password: z.string().min(1).max(MAX_SECRET_LENGTH) })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return fail('INVALID_BODY', 'Enter the password', 400)

  const check = checkVendorPassword(parsed.data.password)
  if (!check.ok) {
    if (check.code === 'VENDOR_DISABLED') return fail('VENDOR_DISABLED', 'Vendor access is not set up on this installation', 503)
    if (check.code === 'LOCKED') return fail('LOCKED', `Too many wrong passwords. Try again in ${check.minutes} minutes.`, 429)
    return fail('INVALID_PASSWORD', 'Wrong password', 401)
  }

  try {
    const tenant = await installationTenant()
    if (!tenant) return fail('NOT_PROVISIONED', 'No tenant configured', 503)
    const cookie = await startVendorSession(tenant.id)
    const response = NextResponse.json({ success: true, data: {} }, { status: 200 })
    response.cookies.set(VENDOR_COOKIE_NAME, cookie, vendorCookieOptions())
    return response
  } catch (error) {
    console.error('[api/vendor/login] Sign-in failed:', error)
    return fail('INTERNAL_ERROR', 'Could not sign in', 500)
  }
}
