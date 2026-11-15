import { z } from 'zod'
import { idParam, menuFail, menuWrite, readBody, versionSchema } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Switch a category back on. Its dishes keep their own on/off. */
export async function POST(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(request, z.object({ version: versionSchema }))
  if (!id || !body) return menuFail('INVALID_BODY', 'The version is required', 400)
  return menuWrite(request, (tx, a) => menu.setCategoryActive(tx, { ...a, id, version: body.version, active: true }))
}
