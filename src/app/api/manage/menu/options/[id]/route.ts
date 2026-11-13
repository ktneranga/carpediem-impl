import { z } from 'zod'
import { idParam, menuFail, menuWrite, nameSchema, paisaSchema, readBody, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Edit an option. */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(
    request,
    z.object({
      version: versionSchema,
      name: nameSchema.optional(),
      priceDeltaPaisa: paisaSchema.optional(),
      isDefault: z.boolean().optional(),
      maxCount: z.number().int().optional(),
      excludesGroupId: z.string().uuid().nullable().optional(),
    }),
  )
  if (!id || !body) return menuFail('INVALID_BODY', 'Invalid option change', 400)
  return menuWrite(request, (tx, a) => menu.updateOption(tx, { ...a, id, ...body }))
}

/** Remove an option. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return menuWrite(request, (tx, a) => menu.removeOption(tx, { ...a, id, version }))
}
