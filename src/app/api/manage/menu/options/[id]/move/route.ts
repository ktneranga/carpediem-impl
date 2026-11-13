import { idParam, menuFail, menuWrite, moveSchema, readBody } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Move one place up or down among its siblings. */
export async function POST(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(request, moveSchema)
  if (!id || !body) return menuFail('INVALID_BODY', 'Say up or down, with the version', 400)
  return menuWrite(request, (tx, a) => menu.moveRow(tx, 'option', { ...a, id, ...body }))
}
