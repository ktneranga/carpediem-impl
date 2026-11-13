import { z } from 'zod'
import { idParam, menuFail, readBody, soldOutWrite } from '@/server/menu-admin/route'
import { emitMenuChanged } from '@/server/socket/events'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ optionId: string }> }

/**
 * An option (a sauce, a side) sold out, or back on (Story 8.3). Options have no
 * fast-path payload, so every tablet refetches the menu (`menu:changed`).
 */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params, 'optionId')
  const body = await readBody(request, z.object({ available: z.boolean() }))
  if (!id || !body) return menuFail('INVALID_BODY', 'Say whether it is available', 400)
  return soldOutWrite(
    request,
    async (tx, a) => {
      const row = await menu.setOptionAvailable(tx, { ...a, id, available: body.available })
      return { id: row.id, available: row.isAvailable, version: row.version }
    },
    () => emitMenuChanged(),
  )
}
