import { z } from 'zod'
import { floorWrite, idParam, idSchema, menuFail, nameSchema, readBody, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as floor from '@/server/services/floor-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Edit a table's label, seats or zone. Allowed while it is occupied. */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(
    request,
    z.object({
      version: versionSchema,
      label: nameSchema.optional(),
      capacity: z.number().int().nullable().optional(),
      zoneId: idSchema.optional(),
    }),
  )
  if (!id || !body) return menuFail('INVALID_BODY', 'Invalid table', 400)
  return floorWrite(request, (tx, a) => floor.updateTable(tx, { ...a, id, ...body }))
}

/** Remove a table; refused while an order (or merged group) is on it. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return floorWrite(request, (tx, a) => floor.setTableActive(tx, { ...a, id, version, active: false }))
}
