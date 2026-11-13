import { z } from 'zod'
import { menuFail, menuWrite, readBody } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

/**
 * Drag and drop: the new order of one whole list (Teran, 2026-11-13).
 * `parentId` is the category of dishes, the dish of groups, the group of
 * options; null for categories.
 */
export async function POST(request: Request) {
  const body = await readBody(
    request,
    z.object({
      kind: z.enum(['category', 'item', 'group', 'option']),
      parentId: z.string().uuid().nullable(),
      ids: z.array(z.string().uuid()).min(1).max(500),
    }),
  )
  if (!body) return menuFail('INVALID_BODY', 'Invalid order', 400)
  return menuWrite(request, (tx, a) => menu.reorderRows(tx, body.kind, { ...a, parentId: body.parentId, ids: body.ids }))
}
