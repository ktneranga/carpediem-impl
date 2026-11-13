import { z } from 'zod'
import { menuFail, menuWrite, nameSchema, readBody } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

/** Add a category (Story 10.4). */
export async function POST(request: Request) {
  const body = await readBody(request, z.object({ name: nameSchema }))
  if (!body) return menuFail('INVALID_BODY', 'A category needs a name', 400)
  return menuWrite(request, (tx, a) => menu.createCategory(tx, { ...a, name: body.name }), 201)
}
