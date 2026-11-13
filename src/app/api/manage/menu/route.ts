import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { menuFail } from '@/server/menu-admin/route'
import { loadMenuForManage } from '@/server/services/menu-admin.service'

/** The menu as the Manage editor needs it, with versions (Story 10.4). `?removed=1` adds removed dishes. */
export async function GET(request: Request) {
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
  try {
    const [member] = await db.select({ tenantId: staff.tenantId }).from(staff).where(eq(staff.id, staffId)).limit(1)
    if (!member) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const includeRemoved = new URL(request.url).searchParams.get('removed') === '1'
    return NextResponse.json({ success: true, data: await loadMenuForManage(db, { tenantId: member.tenantId, includeRemoved }) })
  } catch (error) {
    console.error('[api/manage/menu] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the menu', 500)
  }
}
