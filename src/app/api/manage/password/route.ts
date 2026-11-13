import { NextResponse } from 'next/server'
import {
  currentOwnerSession,
  manageFail,
  readPassword,
  startManageSession,
} from '@/server/auth/manage-route'
import {
  MANAGE_PASSWORD_MAX_BYTES,
  MANAGE_PASSWORD_MIN_BYTES,
  setManagePassword,
} from '@/server/services/manage-password.service'

/**
 * Sets the Manage password the FIRST time (Story 10.0, AC 3), then unlocks as
 * `/api/manage/unlock` does. 201 · 409 ALREADY_SET · 400 for the length.
 *
 * Changing it from inside Manage is out of scope; a forgotten one is cleared
 * on the server with `pnpm manage:reset-password`.
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
