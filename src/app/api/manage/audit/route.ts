import { NextResponse } from 'next/server'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { AUDIT_KIND_LABELS, loadAudit } from '@/server/services/audit.service'
import { auditFiltersFrom, auditStaff } from '@/server/services/audit-request'

/**
 * Manage → Audit (Story 7.6): the log for a date range with its watch-out
 * counts, and the staff list for the filter. Owner, or `manage_audit`
 * (the proxy, via `MANAGE_AREAS`). Read-only.
 */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const filters = await auditFiltersFrom(new URL(request.url), actor.tenantId)
    const [result, people] = await Promise.all([loadAudit(filters), auditStaff(actor.tenantId)])
    return NextResponse.json({
      success: true,
      data: { from: filters.from, to: filters.to, ...result, staff: people, kinds: AUDIT_KIND_LABELS },
    })
  } catch (error) {
    console.error('[api/manage/audit] Failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the audit log', 500)
  }
}
