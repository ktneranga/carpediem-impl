import { NextResponse } from 'next/server'
import { VENDOR_COOKIE_NAME, vendorCookieOptions } from '@/server/services/vendor.service'

/** Vendor sign-out: clears the cookie. The sign-in row stays; it expires on its own. */
export async function POST() {
  const response = NextResponse.json({ success: true, data: {} }, { status: 200 })
  response.cookies.set(VENDOR_COOKIE_NAME, '', { ...vendorCookieOptions(), maxAge: 0 })
  return response
}
