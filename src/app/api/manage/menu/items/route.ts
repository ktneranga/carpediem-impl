import { z } from 'zod'
import { destinationSchema, menuFail, menuWrite, nameSchema, paisaSchema, readBody } from '@/server/menu-admin/route'
import * as menu from '@/server/services/menu-admin.service'

/** Add a dish. */
export async function POST(request: Request) {
  const body = await readBody(
    request,
    z.object({ categoryId: z.string().uuid(), name: nameSchema, pricePaisa: paisaSchema, productionDestination: destinationSchema }),
  )
  if (!body) return menuFail('INVALID_BODY', 'A dish needs a name, category, price and where it prints', 400)
  return menuWrite(request, (tx, a) => menu.createItem(tx, { ...a, ...body }), 201)
}
