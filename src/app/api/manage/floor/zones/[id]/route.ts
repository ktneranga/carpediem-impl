import { z } from 'zod'
import { floorWrite, idParam, menuFail, nameSchema, readBody, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Rename a zone. */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(request, z.object({ version: versionSchema, name: nameSchema }))
  if (!id || !body) return menuFail('INVALID_BODY', 'A name and the version are required', 400)
  return floorWrite(request, (tx, a) => floor.updateZone(tx, { ...a, id, version: body.version, name: body.name }))
}

/** Remove a zone; refused while it has tables. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return floorWrite(request, (tx, a) => floor.removeZone(tx, { ...a, id, version }))
}
