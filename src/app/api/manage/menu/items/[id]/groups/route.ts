import { z } from 'zod'
import { idParam, menuFail, menuWrite, nameSchema, readBody } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Add an option group to a dish. */
export async function POST(request: Request, { params }: Ctx) {
  const itemId = await idParam(params)
  const body = await readBody(
    request,
    z.object({ name: nameSchema, selection: z.enum(['single', 'multi']), isRequired: z.boolean() }),
  )
  if (!itemId || !body) return menuFail('INVALID_BODY', 'A group needs a name, single or multi, and required or not', 400)
  return menuWrite(request, (tx, a) => menu.createGroup(tx, { ...a, itemId, ...body }), 201)
}
