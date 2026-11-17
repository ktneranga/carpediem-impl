import { NextResponse } from 'next/server'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { auditFiltersFrom } from '@/server/services/audit-request'
import { listOrders, ORDER_STATUSES, type OrderStatus } from '@/server/services/orders-list.service'

/**
 * Manage → Orders (Story 7.7): every order of a span of business days.
 * `from`, `to`, `status`, `q` (order number, table or waiter). Owner, or
 * `manage_orders`. Read-only.
 */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const url = new URL(request.url)
    // Same date rules as the audit log: business days, up to today, ~92 days.
    const { from, to } = await auditFiltersFrom(url, actor.tenantId)
    const asked = url.searchParams.get('status')
    const status = (ORDER_STATUSES as readonly string[]).includes(asked ?? '') ? (asked as OrderStatus) : null
    const result = await listOrders({ tenantId: actor.tenantId, from, to, status, search: url.searchParams.get('q')?.slice(0, 40) })
    return NextResponse.json({ success: true, data: { from, to, ...result } })
  } catch (error) {
    console.error('[api/manage/orders] Failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the orders', 500)
  }
}
