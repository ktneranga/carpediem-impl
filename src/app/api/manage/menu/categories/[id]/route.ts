import { z } from 'zod'
import { idParam, menuFail, menuWrite, nameSchema, readBody, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Rename a category. */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(request, z.object({ version: versionSchema, name: nameSchema }))
  if (!id || !body) return menuFail('INVALID_BODY', 'A name and the version are required', 400)
  return menuWrite(request, (tx, a) => menu.updateCategory(tx, { ...a, id, version: body.version, name: body.name }))
}

/** Remove a category; refused while it holds dishes. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return menuWrite(request, (tx, a) => menu.removeCategory(tx, { ...a, id, version }))
}
