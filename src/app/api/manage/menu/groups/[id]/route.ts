import { z } from 'zod'
import { idParam, menuFail, menuWrite, nameSchema, readBody, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Edit an option group. */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(
    request,
    z.object({
      version: versionSchema,
      name: nameSchema.optional(),
      selection: z.enum(['single', 'multi']).optional(),
      isRequired: z.boolean().optional(),
    }),
  )
  if (!id || !body) return menuFail('INVALID_BODY', 'Invalid group change', 400)
  return menuWrite(request, (tx, a) => menu.updateGroup(tx, { ...a, id, ...body }))
}

/** Remove an option group. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return menuWrite(request, (tx, a) => menu.removeGroup(tx, { ...a, id, version }))
}
