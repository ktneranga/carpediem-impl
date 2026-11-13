import { z } from 'zod'
import { idParam, menuFail, menuWrite, nameSchema, paisaSchema, readBody } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/** Add an option to a group. */
export async function POST(request: Request, { params }: Ctx) {
  const groupId = await idParam(params)
  const body = await readBody(
    request,
    z.object({
      name: nameSchema,
      priceDeltaPaisa: paisaSchema,
      isDefault: z.boolean(),
      maxCount: z.number().int(),
      excludesGroupId: z.string().uuid().nullable(),
    }),
  )
  if (!groupId || !body) return menuFail('INVALID_BODY', 'Invalid option', 400)
  return menuWrite(request, (tx, a) => menu.createOption(tx, { ...a, groupId, ...body }), 201)
}
