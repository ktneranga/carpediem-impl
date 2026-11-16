import { count, isNull } from 'drizzle-orm'
import { db } from '@/server/db'
import { orderSessions } from '@/server/db/schema'
import { LoginScreen, type FloorNow } from './login-screen'

// Read on every request: the figure is the floor NOW.
export const dynamic = 'force-dynamic'

/**
 * The sign-in screen, with the number of ongoing orders beside the keypad
 * (Teran, 2026-11-16). A count only — nothing else — since nobody has signed
 * in yet. Every order not closed: tables, sun beds, bar tabs; a merged group
 * is one.
 */
async function readFloor(): Promise<FloorNow | null> {
  try {
    const [ongoing] = await db.select({ n: count() }).from(orderSessions).where(isNull(orderSessions.closedAt))
    return { ongoingOrders: Number(ongoing?.n ?? 0) }
  } catch (error) {
    // The keypad must work even if this read fails.
    console.error('[login] Could not read the floor:', error)
    return null
  }
}

export default async function LoginPage() {
  return <LoginScreen floor={await readFloor()} />
}
