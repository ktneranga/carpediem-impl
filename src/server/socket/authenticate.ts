/**
 * Socket.io handshake authentication and room policy (Story 4.5, AC-11).
 *
 * ── Why this module stands alone ─────────────────────────────────────────────
 * It is imported by `server.ts`, a plain Node process outside Next's module
 * graph. `@/server/db` and the session service both reach `server-only`, whose
 * default export THROWS there. So: its own `pg` pool, plain SQL, relative
 * imports only — the precedent is `src/server/db/sweep-sessions.ts`.
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 * What `validateSession` checks for an HTTP request: the cookie's HMAC, then
 * that the session row exists and its idle age — measured by PostgreSQL's
 * clock — is inside the tenant's timeout. Every room join re-checks, so a
 * socket that connected before its session expired cannot use it to join.
 *
 * ── The kitchen's session is kept alive by its socket ────────────────────────
 * A KITCHEN session's `last_active_at` is refreshed on connect and on join
 * (Teran, 2026-09-20). A kitchen display's only activity IS the socket: it
 * reads, it does not poll, so it would cross the 5-minute idle timeout and then
 * be refused on every reconnect while its current connection kept working.
 * Waiter and owner sessions are NOT refreshed this way — theirs can send orders
 * and take payments, and the idle timeout is what protects an unattended
 * tablet. Story 5.3's ticket status is the kitchen's only write, and it is
 * attributed like any other.
 *
 * ── What it still does not do ────────────────────────────────────────────────
 * A socket already in a room stays there until it disconnects, even if its
 * session expires meanwhile. Sign-out disconnects the device's socket. Logged
 * in deferred-work.md.
 */
import { Pool } from 'pg'
import type { Server, Socket } from 'socket.io'
import { readCookie, SESSION_COOKIE_NAME, verifySessionCookie } from '../auth/session-cookie'
import {
  OWNER_ROOM,
  PRODUCTION_SUBSCRIBE,
  SESSION_ROOM_PREFIX,
  sessionRoom,
} from './rooms'

export type SocketRole = 'owner' | 'waiter' | 'kitchen'

export type SocketIdentity = {
  sessionId: string
  staffId: string
  tenantId: string
  role: SocketRole
}

let pool: Pool | undefined

function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('[socket] DATABASE_URL is not set')
  // Every connect AND every join queries here. Twenty tablets reconnecting
  // after one Wi-Fi blip is forty queries; at max 3 the authentication path
  // itself became the thing keeping staff out.
  pool = new Pool({ connectionString, max: 10 })
  pool.on('error', (error) => console.error('[socket] Auth pool error:', error))
  return pool
}

/**
 * The staff identity behind a raw Cookie header, or null.
 *
 * Every failure — no cookie, bad signature, unknown session, idled out — is the
 * same null, as `validateSession` does, so a caller cannot probe which ids are
 * real.
 */
export async function identityFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<SocketIdentity | null> {
  const sessionId = verifySessionCookie(readCookie(cookieHeader, SESSION_COOKIE_NAME))
  if (!sessionId) return null

  const result = await getPool().query<{
    staff_id: string
    tenant_id: string
    role: SocketRole
    live: boolean
  }>(
    `SELECT s.staff_id,
            s.tenant_id,
            s.role,
            extract(epoch from (now() - s.last_active_at))
              <= coalesce(c.session_timeout_minutes, 5) * 60 AS live
       FROM staff_sessions s
       LEFT JOIN tenant_config c ON c.tenant_id = s.tenant_id
      WHERE s.id = $1
      LIMIT 1`,
    [sessionId],
  )
  const row = result.rows[0]
  if (!row || !row.live) return null

  // See the header: the kitchen's session is kept alive by its socket.
  if (row.role === 'kitchen') {
    try {
      await getPool().query('UPDATE staff_sessions SET last_active_at = now() WHERE id = $1', [
        sessionId,
      ])
    } catch (error) {
      // Refreshing is a convenience; failing it must not refuse the connection.
      console.error('[socket] Could not refresh the kitchen session:', error)
    }
  }

  return { sessionId, staffId: row.staff_id, tenantId: row.tenant_id, role: row.role }
}

/** Is this order in the caller's restaurant? */
async function sessionBelongsToTenant(sessionId: string, tenantId: string): Promise<boolean> {
  const result = await getPool().query(
    'SELECT 1 FROM order_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [sessionId, tenantId],
  )
  return result.rowCount === 1
}

function identityOf(socket: Socket): SocketIdentity | null {
  return (socket.data as { identity?: SocketIdentity }).identity ?? null
}

/** `io.use(...)` — refuses any connection without a live staff session. */
export async function authenticateSocket(
  socket: Socket,
  next: (error?: Error) => void,
): Promise<void> {
  try {
    const identity = await identityFromCookieHeader(socket.handshake.headers.cookie)
    if (!identity) {
      next(new Error('UNAUTHENTICATED'))
      return
    }
    ;(socket.data as { identity?: SocketIdentity }).identity = identity
    next()
  } catch (error) {
    // A database outage must not let anyone in. The client retries — see
    // `useSocketRoom`'s sibling in `use-socket.ts`: Socket.io does NOT retry a
    // middleware rejection on its own.
    console.error('[socket] Handshake authentication failed:', error)
    next(new Error('UNAUTHENTICATED'))
  }
}

type Ack = (result: { ok: boolean; error?: string }) => void

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Attaches the join commands to every connection (AC-11).
 *
 * - `kitchen:subscribe`, `pizza:subscribe`, `bar:subscribe` → `kitchen` role.
 *   There is no bar or pizza role; one kitchen login serves every station until
 *   Epic 10 adds station users (deferred-work.md).
 * - `owner:subscribe` → `owner` role.
 * - `session:subscribe { sessionId }` → `waiter` or `owner`, AND the order must
 *   be in the caller's own restaurant. Role alone was not enough: a session id
 *   from another tenant would have been joined without question.
 * - `session:unsubscribe { sessionId }` → leaves, so a tablet that navigates
 *   back to the floor stops receiving that order's confirmations.
 *
 * Every handler is wrapped: Socket.io does not catch a rejected listener, and
 * an unhandled rejection takes down the process serving the whole POS.
 */
export function registerRoomHandlers(io: Server): void {
  io.on('connection', (socket) => {
    async function allowed(roles: SocketRole[]): Promise<SocketIdentity | null> {
      const identity = identityOf(socket)
      if (!identity || !roles.includes(identity.role)) return null
      try {
        const current = await identityFromCookieHeader(socket.handshake.headers.cookie)
        if (!current || current.staffId !== identity.staffId) return null
        return current
      } catch (error) {
        console.error('[socket] Join re-check failed:', error)
        return null
      }
    }

    function reply(ack: unknown, result: { ok: boolean; error?: string }) {
      if (typeof ack === 'function') (ack as Ack)(result)
    }

    /** Runs a handler so no rejection escapes into the process. */
    function handle(command: string, run: (args: unknown, ack: unknown) => Promise<void>) {
      socket.on(command, (...received: unknown[]) => {
        const ack = received.length > 1 ? received[1] : received[0]
        const args = received.length > 1 ? received[0] : undefined
        void run(args, ack).catch((error) => {
          console.error(`[socket] ${command} failed:`, error)
          reply(ack, { ok: false, error: 'INTERNAL_ERROR' })
        })
      })
    }

    for (const [command, room] of Object.entries(PRODUCTION_SUBSCRIBE)) {
      handle(command, async (_args, ack) => {
        if (!(await allowed(['kitchen']))) return reply(ack, { ok: false, error: 'FORBIDDEN' })
        await socket.join(room)
        reply(ack, { ok: true })
      })
    }

    handle('owner:subscribe', async (_args, ack) => {
      if (!(await allowed(['owner']))) return reply(ack, { ok: false, error: 'FORBIDDEN' })
      await socket.join(OWNER_ROOM)
      reply(ack, { ok: true })
    })

    handle('session:subscribe', async (args, ack) => {
      const sessionId =
        typeof args === 'object' && args !== null
          ? (args as { sessionId?: unknown }).sessionId
          : undefined
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
        return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' })
      }

      const identity = await allowed(['waiter', 'owner'])
      if (!identity) return reply(ack, { ok: false, error: 'FORBIDDEN' })

      // The order must be in this staff member's restaurant. Without this, a
      // role check alone let any waiter join any order's room in any tenant.
      if (!(await sessionBelongsToTenant(sessionId, identity.tenantId))) {
        return reply(ack, { ok: false, error: 'FORBIDDEN' })
      }

      // A tablet looks at one order at a time; leave any previous one so a long
      // shift does not accumulate every table's confirmations.
      for (const room of socket.rooms) {
        if (room.startsWith(SESSION_ROOM_PREFIX) && room !== sessionRoom(sessionId)) {
          await socket.leave(room)
        }
      }
      await socket.join(sessionRoom(sessionId))
      reply(ack, { ok: true })
    })

    handle('session:unsubscribe', async (args, ack) => {
      const sessionId =
        typeof args === 'object' && args !== null
          ? (args as { sessionId?: unknown }).sessionId
          : undefined
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
        return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' })
      }
      await socket.leave(sessionRoom(sessionId))
      reply(ack, { ok: true })
    })
  })
}
