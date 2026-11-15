import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { buildMenuWorkbook, parseMenuWorkbook } from '@/server/menu-import/workbook'
import { importMenu, ImportRejectedError } from '@/server/services/menu-import.service'
import { loadMenuForManage, MenuNotFoundError, MenuRuleError, StaleVersionError } from '@/server/services/menu-admin.service'
import { emitMenuChanged } from '@/server/socket/events'

/**
 * Manage → Menu → Bulk upload (spec-menu-bulk-upload-excel). Gated like the
 * rest of `/api/manage/menu` by the proxy (owner, or `manage_menu`).
 *
 * GET  — the current menu as the .xlsx to fill in.
 * POST — multipart `file`: checked and summarised; with `?apply=1`, imported.
 */

const MAX_BYTES = 1024 * 1024
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(request: Request) {
  const actor = await actorOf(request)
  if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
  try {
    const book = await buildMenuWorkbook(await loadMenuForManage(db, { tenantId: actor.tenantId, includeRemoved: false }))
    const day = new Date().toISOString().slice(0, 10)
    return new NextResponse(new Uint8Array(book), {
      headers: {
        'content-type': XLSX,
        'content-disposition': `attachment; filename="menu-${day}.xlsx"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[api/manage/menu/import] Download failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not make the menu sheet', 500)
  }
}

export async function POST(request: Request) {
  const actor = await actorOf(request)
  if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
  const apply = new URL(request.url).searchParams.get('apply') === '1'
  const tooBig = () => menuFail('INVALID_FILE', 'Choose the .xlsx you downloaded (1 MB at most)', 400)
  // Refused before the body is read: formData() would hold it all in memory.
  // (The multipart wrapper adds a little; 64 KB of slack covers it.)
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES + 64 * 1024) return tooBig()

  let file: File | null = null
  try {
    const value = (await request.formData()).get('file')
    file = value instanceof File ? value : null
  } catch {
    file = null
  }
  if (!file || file.size === 0 || file.size > MAX_BYTES || !file.name.toLowerCase().endsWith('.xlsx')) return tooBig()

  try {
    const parsed = await parseMenuWorkbook(await file.arrayBuffer())
    // Not a workbook, or not ours (no Dishes sheet, wrong headings): one
    // file-level message, as a wrong file — there are no rows to list.
    const fileProblem = parsed.errors.find((error) => error.row <= 1)
    if (fileProblem) return menuFail('INVALID_FILE', fileProblem.message, 400)
    // Always checked first, writing nothing; the owner sees this summary.
    const plan = await db.transaction(
      (tx) => importMenu(tx, { ...actor, parsed, apply: false }),
      { accessMode: 'read only' },
    )
    if (plan.errors.length > 0) {
      return NextResponse.json(
        { success: false, error: { code: 'SHEET_ERRORS', message: 'Fix the rows listed and upload again' }, data: plan },
        { status: 422 },
      )
    }
    if (!apply) return NextResponse.json({ success: true, data: plan })

    const done = await db.transaction((tx) => importMenu(tx, { ...actor, parsed, apply: true }))
    const changed = [done.categories, done.dishes, done.groups, done.options].some((c) => c.new + c.updated > 0)
    if (changed) emitMenuChanged()
    return NextResponse.json({ success: true, data: done })
  } catch (error) {
    // The menu changed between the check and the import: nothing was written.
    if (error instanceof ImportRejectedError || error instanceof StaleVersionError || error instanceof MenuNotFoundError) {
      return menuFail('STALE', 'The menu changed meanwhile. Check the file again.', 409)
    }
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error('[api/manage/menu/import] Import failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not import the menu', 500)
  }
}
