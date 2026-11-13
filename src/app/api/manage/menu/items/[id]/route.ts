import { z } from 'zod'
import { destinationSchema, idParam, menuFail, menuWrite, nameSchema, paisaSchema, readBody, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Edit a dish: any of name, category, price, where it prints. */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(
    request,
    z.object({
      version: versionSchema,
      name: nameSchema.optional(),
      categoryId: z.string().uuid().optional(),
      pricePaisa: paisaSchema.optional(),
      productionDestination: destinationSchema.optional(),
    }),
  )
  if (!id || !body) return menuFail('INVALID_BODY', 'Invalid dish change', 400)
  return menuWrite(request, (tx, a) => menu.updateItem(tx, { ...a, id, ...body }))
}

/** Remove a dish from the menu. Nothing is deleted. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return menuWrite(request, (tx, a) => menu.setItemActive(tx, { ...a, id, version, active: false }))
}
