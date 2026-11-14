import { z } from 'zod'
import { idParam, menuFail, readBody, staffFields, staffWrite, versionParam, versionSchema } from '@/server/menu-admin/route'
import * as staffAdmin from '@/server/services/staff-admin.service'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Edit someone: `{ version, name?, jobTitle?, pin? }`, or deactivate / reactivate:
 * `{ version, active, pin? }` (reactivate needs a PIN). Only what is given changes.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const body = await readBody(
    request,
    z.object({
      version: versionSchema,
      name: staffFields.name.optional(),
      jobTitle: staffFields.jobTitle.optional(),
      pin: staffFields.pin.optional(),
      permissions: staffFields.permissions,
      active: z.boolean().optional(),
    }),
  )
  if (!id || !body) return menuFail('INVALID_BODY', 'Invalid staff change', 400)
  const { active, ...change } = body
  if (active !== undefined) {
    return staffWrite(request, (tx, a) =>
      staffAdmin.setStaffActive(tx, { ...a, id, version: change.version, active, pin: change.pin }))
  }
  return staffWrite(request, (tx, a) => staffAdmin.updateStaff(tx, { ...a, id, ...change }))
}

/** Delete someone with no history (added by mistake); otherwise 409 HAS_HISTORY — deactivate instead. */
export async function DELETE(request: Request, { params }: Ctx) {
  const id = await idParam(params)
  const version = versionParam(request)
  if (!id || !version) return menuFail('INVALID_BODY', 'The version is required', 400)
  return staffWrite(request, (tx, a) => staffAdmin.deleteStaff(tx, { ...a, id, version }))
}
