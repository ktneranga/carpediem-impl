/**
 * Socket.io handshake authentication and room policy (Story 4.5, AC-11).
 *
 * ── Why this module stands alone ─────────────────────────────────────────────
 * It is imported by `server.ts`, a plain Node process outside Next's module
 * graph. `@/server/db` and the session service both reach `server-only`, whose
 * default export THROWS there. So: its own tiny `pg` pool, plain SQL, relative
 * imports only — the precedent is `src/server/db/sweep-sessions.ts`.
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 * Exactly what `validateSession` checks for an HTTP request: the cookie's HMAC,
 * then that the session row exists and its idle age — measured by PostgreSQL's
 * clock, not Node's — is inside the tenant's timeout. It does not destroy an
 * expired row; the proxy and the ten-minute sweep already do.
 *
 * ── What it does not check ───────────────────────────────────────────────────
 * The session is checked when the socket CONNECTS and again on every room join.
 * A socket already in a room stays there until it disconnects, even if the
 * session idles out meanwhile. Sign-out disconnects the device's socket
 * (`disconnectSocket`); an idle-expired socket is closed only when it drops.
 * Logged in deferred-work.md.
 */
import { Pool } from 'pg'
import type { Server, Socket } from 'socket.io'
import { readCookie, SESSION_COOKIE_NAME, verifySessionCookie } from '../auth/session-cookie'

export type SocketRole = 'owner' | 'waiter' | 'kitchen'

export type SocketIdentity = {
  staffId: string
  role: SocketRole
}

let pool: Pool | undefined

function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('[socket] DATABASE_URL is not set')
  // Small: one query per connect and per join, both brief.
  pool = new Pool({ connectionString, max: 3 })
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

  const result = await getPool().query<{ staff_id: string; role: SocketRole; live: boolean }>(
    `SELECT s.staff_id,
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
  return { staffId: row.staff_id, role: row.role }
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
    // A database outage must not let anyone in.
    console.error('[socket] Handshake authentication failed:', error)
    next(new Error('UNAUTHENTICATED'))
  }
}

type Ack = (result: { ok: boolean; error?: string }) => void

/** Which roles may join which production room. The kitchen role serves every station. */
const PRODUCTION_ROOMS: Record<string, string> = {
  'kitchen:subscribe': 'kitchen',
  'pizza:subscribe': 'pizza_kitchen',
  'bar:subscribe': 'bar',
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Attaches the join commands to every connection (AC-11).
 *
 * - `kitchen:subscribe`, `pizza:subscribe`, `bar:subscribe` → `kitchen` role.
 *   There is no bar or pizza role; one kitchen login serves every station until
 *   Epic 10 adds station users (deferred-work.md).
 * - `owner:subscribe` → `owner` role.
 * - `session:subscribe { sessionId }` → `waiter` or `owner`.
 *
 * Every join re-checks the session against the database, so a socket that
 * connected before its session idled out cannot use that to join a room.
 * A refused join answers through the ack and never throws.
 */
export function registerRoomHandlers(io: Server): void {
  io.on('connection', (socket) => {
    async function allowed(roles: SocketRole[]): Promise<boolean> {
      const identity = identityOf(socket)
      if (!identity || !roles.includes(identity.role)) return false
      try {
        const current = await identityFromCookieHeader(socket.handshake.headers.cookie)
        return current !== null && current.staffId === identity.staffId
      } catch (error) {
        console.error('[socket] Join re-check failed:', error)
        return false
      }
    }

    function reply(ack: unknown, result: { ok: boolean; error?: string }) {
      if (typeof ack === 'function') (ack as Ack)(result)
    }

    for (const [command, room] of Object.entries(PRODUCTION_ROOMS)) {
      socket.on(command, async (ack?: unknown) => {
        if (!(await allowed(['kitchen']))) return reply(ack, { ok: false, error: 'FORBIDDEN' })
        await socket.join(room)
        reply(ack, { ok: true })
      })
    }

    socket.on('owner:subscribe', async (ack?: unknown) => {
      if (!(await allowed(['owner']))) return reply(ack, { ok: false, error: 'FORBIDDEN' })
      await socket.join('owner')
      reply(ack, { ok: true })
    })

    socket.on('session:subscribe', async (args: unknown, ack?: unknown) => {
      const sessionId =
        typeof args === 'object' && args !== null
          ? (args as { sessionId?: unknown }).sessionId
          : undefined
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
        return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' })
      }
      if (!(await allowed(['waiter', 'owner']))) {
        return reply(ack, { ok: false, error: 'FORBIDDEN' })
      }
      // A tablet looks at one order at a time; leave any previous one so a
      // long shift does not accumulate every table's confirmations.
      for (const room of socket.rooms) {
        if (room.startsWith('session:') && room !== `session:${sessionId}`) {
          await socket.leave(room)
        }
      }
      await socket.join(`session:${sessionId}`)
      reply(ack, { ok: true })
    })
  })
}
