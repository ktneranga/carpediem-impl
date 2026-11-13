import { soldOutWrite } from '@/server/menu-admin/route'
import { emitMenuChanged } from '@/server/socket/events'
import * as menu from '@/server/services/menu-admin.service'

/**
 * Put everything back on (Story 8.3): every sold-out dish AND option, in one
 * transaction, one `menu:changed` after it. Returns `{ count }`.
 */
export async function POST(request: Request) {
  return soldOutWrite(request, (tx, a) => menu.resetAvailability(tx, a), () => emitMenuChanged())
}
