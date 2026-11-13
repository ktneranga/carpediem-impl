import { z } from 'zod'
import { idParam, menuFail, readBody, soldOutWrite } from '@/server/menu-admin/route'
import { emitMenuItemUpdated } from '@/server/socket/events'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ itemId: string }> }

/**
 * A dish sold out, or back on (Story 8.3). Owner and waiters, no Manage
 * password. Last write wins — no version is sent. After commit every tablet
 * hears `menu:item_updated` and patches its menu.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params, 'itemId')
  const body = await readBody(request, z.object({ available: z.boolean() }))
  if (!id || !body) return menuFail('INVALID_BODY', 'Say whether it is available', 400)
  return soldOutWrite(
    request,
    async (tx, a) => {
      const row = await menu.setItemAvailable(tx, { ...a, id, available: body.available })
      return { id: row.id, available: row.isAvailable, version: row.version, portionCount: row.portionCount }
    },
    ({ id: itemId, available, portionCount }) => emitMenuItemUpdated({ itemId, available, portionCount }),
  )
}
