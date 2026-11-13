import { z } from 'zod'
import { floorWrite, idParam, menuFail, nameSchema, readBody } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Add a table to a zone, at the end of it. Seats are optional (the service checks 1–30). */
export async function POST(request: Request, { params }: Ctx) {
  const zoneId = await idParam(params)
  const body = await readBody(request, z.object({ label: nameSchema, capacity: z.number().int().nullable() }))
  if (!zoneId || !body) return menuFail('INVALID_BODY', 'A label is required', 400)
  return floorWrite(request, (tx, a) => floor.createTable(tx, { ...a, zoneId, label: body.label, capacity: body.capacity }), 201)
}
