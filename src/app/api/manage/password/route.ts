import { NextResponse } from 'next/server'
import {
  currentOwnerSession,
  manageFail,
  readPassword,
  startManageSession,
} from '@/server/auth/manage-route'
import {
  changeManagePassword,
  MANAGE_PASSWORD_MAX_BYTES,
  MANAGE_PASSWORD_MIN_BYTES,
  setManagePassword,
} from '@/server/services/manage-password.service'

/**
 * Sets the Manage password the FIRST time (Story 10.0, AC 3), then unlocks as
 * `/api/manage/unlock` does. 201 · 409 ALREADY_SET · 400 for the length.
 *
 * Changing it is `PUT` below (Teran, 2026-11-16); a FORGOTTEN one is still
 * cleared on the server with `pnpm manage:reset-password`.
 */
export async function POST(request: Request) {
  const password = await readPassword(request)
  if (password === null) return manageFail('INVALID_BODY', 'Password required', 400)

  try {
    const session = await currentOwnerSession()
    if (!session) return manageFail('FORBIDDEN', 'Only the owner can open Manage', 403)

    const result = await setManagePassword(session.tenantId, password)

    if (result.kind === 'invalid-length') {
      return manageFail(
        'INVALID_LENGTH',
        `Use ${MANAGE_PASSWORD_MIN_BYTES}–${MANAGE_PASSWORD_MAX_BYTES} characters`,
        400,
      )
    }
    if (result.kind === 'already-set') {
      return manageFail('ALREADY_SET', 'A Manage password is already set', 409)
    }

    await startManageSession(session.sessionId)
    return NextResponse.json({ success: true, data: null }, { status: 201 })
  } catch (error) {
    console.error('[manage/password] Unexpected failure:', error)
    return manageFail('INTERNAL_ERROR', 'Could not set the password', 500)
  }
}

/**
 * Changes the Manage password (Teran, 2026-11-16): `{ current, next }`.
 * Owner only — `/api/manage` is owner-only and this path is in no Manage area,
 * so a staff member granted Settings cannot reach it. The current password is
 * checked through the unlock lockout. 200 · 401 WRONG_PASSWORD · 423 LOCKED ·
 * 400 for the length. Never echoes either password.
 */
export async function PUT(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return manageFail('INVALID_BODY', 'Passwords required', 400)
  }
  const { current, next } = (body ?? {}) as { current?: unknown; next?: unknown }
  if (typeof current !== 'string' || typeof next !== 'string') {
    return manageFail('INVALID_BODY', 'Passwords required', 400)
  }

  try {
    const session = await currentOwnerSession()
    if (!session) return manageFail('FORBIDDEN', 'Only the owner can change the password', 403)

    const result = await changeManagePassword(session.tenantId, {
      current,
      next,
      keepStaffSessionId: session.sessionId,
    })
    switch (result.kind) {
      case 'changed':
        return NextResponse.json({ success: true, data: null })
      case 'invalid-length':
        return manageFail('INVALID_LENGTH', `Use ${MANAGE_PASSWORD_MIN_BYTES}–${MANAGE_PASSWORD_MAX_BYTES} characters`, 400)
      case 'wrong':
        return manageFail('WRONG_PASSWORD', `The current password is wrong — ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left`, 401)
      case 'locked':
        return manageFail('LOCKED', `Too many wrong tries. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} min.`, 423)
      case 'not-set':
        return manageFail('NOT_SET', 'No Manage password is set yet', 409)
    }
  } catch (error) {
    console.error('[manage/password] Change failed:', error)
    return manageFail('INTERNAL_ERROR', 'Could not change the password', 500)
  }
}
