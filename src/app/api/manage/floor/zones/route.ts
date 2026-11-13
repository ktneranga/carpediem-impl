import { z } from 'zod'
import { floorWrite, menuFail, nameSchema, readBody } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

/** Add a zone, at the end of the floor. */
export async function POST(request: Request) {
  const body = await readBody(request, z.object({ name: nameSchema }))
  if (!body) return menuFail('INVALID_BODY', 'A name is required', 400)
  return floorWrite(request, (tx, a) => floor.createZone(tx, { ...a, name: body.name }), 201)
}
