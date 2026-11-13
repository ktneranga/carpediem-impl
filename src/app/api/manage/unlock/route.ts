import { NextResponse } from 'next/server'
import {
  currentOwnerSession,
  manageFail,
  readPassword,
  startManageSession,
} from '@/server/auth/manage-route'
import { checkManagePassword } from '@/server/services/manage-password.service'

/**
 * Unlocks the Manage area for THIS POS session (Story 10.0, AC 2, 4).
 *
 * 200 + Manage cookie · 401 WRONG_PASSWORD { attemptsLeft } · 429 LOCKED
 * { retryAfterSeconds } + Retry-After · 409 NOT_SET.
 *
 * The password is never logged and never in a message: errors log the error
 * object only.
 */
export async function POST(request: Request) {
  const password = await readPassword(request)
  if (password === null) return manageFail('INVALID_BODY', 'Password required', 400)

  try {
    const session = await currentOwnerSession()
    if (!session) return manageFail('FORBIDDEN', 'Only the owner can open Manage', 403)

    const result = await checkManagePassword(session.tenantId, password)

    switch (result.kind) {
      case 'not-set':
        return manageFail('NOT_SET', 'No Manage password yet — choose one', 409)
      case 'locked': {
        const response = manageFail('LOCKED', 'Too many tries', 429, {
          retryAfterSeconds: result.retryAfterSeconds,
        })
        response.headers.set('Retry-After', String(result.retryAfterSeconds))
        return response
      }
      case 'wrong':
        return manageFail('WRONG_PASSWORD', 'Wrong password', 401, {
          attemptsLeft: result.attemptsLeft,
        })
      case 'ok':
        await startManageSession(session.sessionId)
        return NextResponse.json({ success: true, data: null }, { status: 200 })
    }
  } catch (error) {
    console.error('[manage/unlock] Unexpected failure:', error)
    return manageFail('INTERNAL_ERROR', 'Could not unlock', 500)
  }
}
