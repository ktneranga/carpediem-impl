import ExcelJS from 'exceljs'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { AUDIT_KIND_LABELS, loadAudit } from '@/server/services/audit.service'
import { auditFiltersFrom } from '@/server/services/audit-request'
import { db } from '@/server/db'
import { tenants } from '@/server/db/schema'
import { eq } from 'drizzle-orm'

/**
 * The filtered audit log as an Excel file (Story 7.6) — the same rows the
 * screen shows, for the accountant or a dispute. Times in the restaurant's zone.
 */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const filters = await auditFiltersFrom(new URL(request.url), actor.tenantId)
    const { entries } = await loadAudit(filters)
    const [tenant] = await db.select({ timeZone: tenants.timezone }).from(tenants).where(eq(tenants.id, actor.tenantId)).limit(1)
    const timeZone = tenant?.timeZone ?? 'Asia/Colombo'
    const dateOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const timeOf = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Audit')
    sheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Time', key: 'time', width: 10 },
      { header: 'Staff', key: 'staff', width: 16 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'What happened', key: 'text', width: 60 },
      { header: 'Detail', key: 'detail', width: 36 },
      { header: 'Order', key: 'order', width: 8 },
      { header: 'Table', key: 'place', width: 12 },
      { header: 'Amount (LKR)', key: 'amount', width: 14 },
    ]
    sheet.getRow(1).font = { bold: true }
    for (const entry of entries) {
      const at = new Date(entry.at)
      sheet.addRow({
        date: dateOf.format(at),
        time: timeOf.format(at),
        staff: entry.staffName,
        type: AUDIT_KIND_LABELS[entry.kind],
        text: entry.text,
        detail: entry.detail ?? '',
        order: entry.orderLabel ?? '',
        place: entry.place ?? '',
        amount: entry.amountPaisa === null ? null : entry.amountPaisa / 100,
      })
    }
    sheet.getColumn('amount').numFmt = '#,##0.00'
    const buffer = Buffer.from(await book.xlsx.writeBuffer())
    const name = filters.from === filters.to ? filters.from : `${filters.from}_to_${filters.to}`
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="audit_${name}.xlsx"`,
      },
    })
  } catch (error) {
    console.error('[api/manage/audit/export] Failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not export the audit log', 500)
  }
}
