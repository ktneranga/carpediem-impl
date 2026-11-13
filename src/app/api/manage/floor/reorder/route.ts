import { z } from 'zod'
import { floorWrite, menuFail, readBody } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

/** Drag and drop: the new order of the zones (`parentId` null) or of one zone's tables. */
export async function POST(request: Request) {
  const body = await readBody(
    request,
    z.object({
      kind: z.enum(['zone', 'table']),
      parentId: z.string().uuid().nullable(),
      ids: z.array(z.string().uuid()).min(1).max(500),
    }),
  )
  if (!body) return menuFail('INVALID_BODY', 'Invalid order', 400)
  return floorWrite(request, (tx, a) => floor.reorderRows(tx, body.kind, { ...a, parentId: body.parentId, ids: body.ids }))
}
