import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { and, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db } from '@/server/db'
import { staff, tenants } from '@/server/db/schema'
import { createSession, SESSION_COOKIE_NAME } from '@/server/services/session.service'

// PIN never reaches bcrypt unless it is exactly 4-6 digits.
const loginSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/),
})

/**
 * Compared against when a tenant has no active staff, so an empty-staff response
 * is not instantly distinguishable from a wrong-PIN response. Cost factor 10,
 * matching architecture.md:205.
 */
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Request body must be JSON' } },
      { status: 400 },
    )
  }

  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    // Deliberately does NOT include Zod's issue list — its default error echoes
    // the received value, which here is the plaintext PIN (NFR-S1).
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'PIN must be 4-6 digits' } },
      { status: 400 },
    )
  }

  const { pin } = parsed.data

  try {
    // Single-tenant-per-stack (NFR-SC1): exactly one tenant row exists.
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1)

    if (!tenant) {
      // Not provisioned. Still burn one compare so this is not a fast-path oracle.
      await bcrypt.compare(pin, DUMMY_HASH)
      return NextResponse.json(
        { success: false, error: { code: 'NOT_PROVISIONED', message: 'No tenant configured' } },
        { status: 503 },
      )
    }

    const activeStaff = await db
      .select({
        id: staff.id,
        name: staff.name,
        role: staff.role,
        pinHash: staff.pinHash,
      })
      .from(staff)
      .where(and(eq(staff.tenantId, tenant.id), eq(staff.isActive, true)))

    let matched: (typeof activeStaff)[number] | null = null

    if (activeStaff.length === 0) {
      await bcrypt.compare(pin, DUMMY_HASH)
    } else {
      for (const candidate of activeStaff) {
        // No `break` on match. Stopping early would make a successful attempt
        // measurably faster than a failed one, leaking PIN validity by timing
        // alone (AC-3). Every login costs N compares by design.
        const isMatch = await bcrypt.compare(pin, candidate.pinHash)
        if (isMatch && matched === null) {
          matched = candidate
        }
      }
    }

    if (!matched) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_PIN', message: 'Incorrect PIN' } },
        { status: 401 },
      )
    }

    const session = await createSession({
      tenantId: tenant.id,
      staffId: matched.id,
      role: matched.role,
    })

    const cookieStore = await cookies()
    cookieStore.set(SESSION_COOKIE_NAME, session.cookieValue, {
      httpOnly: true,
      sameSite: 'strict',
      // CONDITIONAL, not always true. The restaurant LAN serves plain HTTP on
      // :3000, and a browser never sends a Secure cookie over HTTP — login would
      // appear to succeed and then silently never persist. NFR-S5 keeps the LAN
      // closed to the public internet, which is what makes this acceptable.
      // Set HTTPS_ENABLED=true once the app is served over TLS.
      secure: process.env.NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true',
      path: '/',
      maxAge: session.timeoutMinutes * 60,
    })

    return NextResponse.json(
      { success: true, data: { role: matched.role, staffName: matched.name } },
      { status: 200 },
    )
  } catch (error) {
    // Log the error object only. It must never be constructed from the PIN.
    console.error('[auth/login] Unexpected failure:', error)
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Authentication failed' } },
      { status: 500 },
    )
  }
}
