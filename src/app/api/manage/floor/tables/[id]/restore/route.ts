import { z } from 'zod'
import { floorWrite, idParam, idSchema, menuFail, readBody, versionSchema } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Bring a removed table back. `zoneId` only when its own zone has been removed since. */
export async function POST(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(request, z.object({ version: versionSchema, zoneId: idSchema.optional() }))
  if (!id || !body) return menuFail('INVALID_BODY', 'The version is required', 400)
  return floorWrite(request, (tx, a) =>
    floor.setTableActive(tx, { ...a, id, version: body.version, active: true, zoneId: body.zoneId }),
  )
}
