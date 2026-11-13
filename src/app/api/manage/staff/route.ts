import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { actorOf, menuFail, readBody, staffFields, staffWrite } from '@/server/menu-admin/route'
import * as staffAdmin from '@/server/services/staff-admin.service'

/**
 * Manage → Staff (Story 10.2). Behind both gates (owner + Manage password) via
 * the `/api/manage` prefix. The body is never echoed or logged: it holds a PIN.
 */

/** Everyone in the tenant, active and deactivated. Never a PIN hash. */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    return NextResponse.json({ success: true, data: await staffAdmin.loadStaffForManage(db, actor.tenantId) })
  } catch (error) {
    console.error('[api/manage/staff] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the staff', 500)
  }
}

/** Add someone. */
export async function POST(request: Request) {
  const body = await readBody(request, z.object(staffFields))
  if (!body) return menuFail('INVALID_BODY', 'A name, job and PIN are required', 400)
  return staffWrite(request, (tx, a) => staffAdmin.createStaff(tx, { ...a, ...body }), 201)
}
