import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { AUDIT_KINDS, type AuditFilters, type AuditKind } from '@/server/services/audit.service'
import { todayBusinessDate } from '@/server/services/takings.service'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The audit filters from a query string (Story 7.6): `from`, `to` (business
 * dates, default today; at most 92 days), `staff`, `kinds` (comma list),
 * `q` (order number or table). Anything malformed falls back, never throws.
 */
export async function auditFiltersFrom(url: URL, tenantId: string): Promise<AuditFilters> {
  const today = await todayBusinessDate(db, tenantId)
  let from = url.searchParams.get('from') ?? today
  let to = url.searchParams.get('to') ?? from
  if (!DATE.test(from)) from = today
  if (!DATE.test(to) || to > today) to = today
  if (from > to) from = to
  // A wide range is slow to read and no one scrolls it: cap at about a quarter.
  const earliest = new Date(`${to}T00:00:00Z`)
  earliest.setUTCDate(earliest.getUTCDate() - 92)
  const floor = earliest.toISOString().slice(0, 10)
  if (from < floor) from = floor

  const kinds = (url.searchParams.get('kinds') ?? '')
    .split(',')
    .filter((kind): kind is AuditKind => (AUDIT_KINDS as readonly string[]).includes(kind))
  const staffId = url.searchParams.get('staff')
  return {
    tenantId,
    from,
    to,
    staffId: staffId && /^[0-9a-f-]{36}$/i.test(staffId) ? staffId : null,
    kinds: kinds.length ? kinds : null,
    search: url.searchParams.get('q')?.slice(0, 40) ?? null,
  }
}

/** Everyone who can appear in the log, for the staff filter (left staff too). */
export async function auditStaff(tenantId: string) {
  return db
    .select({ id: staff.id, name: staff.name, isActive: staff.isActive })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId)))
    .orderBy(asc(staff.name))
}
