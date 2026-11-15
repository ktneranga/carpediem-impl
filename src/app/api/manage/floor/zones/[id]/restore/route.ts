import { z } from 'zod'
import { floorWrite, idParam, menuFail, readBody, versionSchema } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Switch a zone back on. Its tables keep their own on/off. */
export async function POST(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(request, z.object({ version: versionSchema }))
  if (!id || !body) return menuFail('INVALID_BODY', 'The version is required', 400)
  return floorWrite(request, (tx, a) => floor.setZoneActive(tx, { ...a, id, version: body.version, active: true }))
}
