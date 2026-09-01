import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server } from 'socket.io'

const dev = process.env.NODE_ENV !== 'production'

// Fail at boot, not at the first login attempt during dinner service. A server
// running with a weak or absent signing secret would issue forgeable session
// cookies and nobody would notice until it mattered.
// (Closes a deferred item from Story 1.1's code review.)
const MIN_SESSION_SECRET_LENGTH = 32
const sessionSecret = process.env.SESSION_SECRET

if (!sessionSecret || sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
  console.error(
    `[server] SESSION_SECRET is ${!sessionSecret ? 'not set' : `only ${sessionSecret.length} characters`}. ` +
      `It must be at least ${MIN_SESSION_SECRET_LENGTH} characters — it signs staff session cookies.\n` +
      `        Generate one with:  openssl rand -hex 32\n` +
      `        Set it in .env.local for local development, or in docker-compose.yml for a deployment.`,
  )
  process.exit(1)
}

const app = next({ dev })
const handle = app.getRequestHandler()

app
  .prepare()
  .then(() => {
    const httpServer = createServer((req, res) => {
      // P6: req.url is undefined only on server-initiated requests; safe fallback avoids non-null assertion
      const parsedUrl = parse(req.url ?? '/', true)
      handle(req, res, parsedUrl)
    })

    const io = new Server(httpServer, {
      cors: { origin: false }, // LAN-only — no cross-origin needed
    })

    // Expose io on global so src/server/socket/index.ts can export it
    // without creating a circular dependency on server.ts
    global.__io = io

    io.on('connection', (socket) => {
      console.log('[socket.io] client connected:', socket.id)
      socket.on('disconnect', () => {
        console.log('[socket.io] client disconnected:', socket.id)
      })
    })

    const port = parseInt(process.env.PORT ?? '3000', 10)

    // P2: Catch EADDRINUSE and other bind errors before they become unhandled 'error' events
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[server] Port ${port} is already in use — is another instance running?`)
      } else {
        console.error('[server] HTTP server error:', err)
      }
      process.exit(1)
    })

    // Reap sessions nobody came back to. The proxy only deletes expired rows it
    // actually encounters, so a staff member who closes the tab and never
    // returns would leave a row forever.
    const SWEEP_INTERVAL_MS = 10 * 60 * 1000
    let sweepRunning = false

    const sweepExpiredSessions = async () => {
      if (sweepRunning) return // never let a slow sweep overlap itself
      sweepRunning = true
      try {
        // Imports the standalone reaper, NOT the session service — that module
        // reaches @/server/db, which is marked `server-only` and throws outside
        // Next's module graph.
        const { sweepExpiredSessions: sweep } = await import('./src/server/db/sweep-sessions')
        const removed = await sweep()
        if (removed > 0) {
          console.log(`[sessions] Swept ${removed} expired session(s)`)
        }
      } catch (err) {
        // A failed sweep is housekeeping, never a reason to take the server down.
        console.error('[sessions] Sweep failed:', err)
      } finally {
        sweepRunning = false
      }
    }

    const sweepTimer = setInterval(sweepExpiredSessions, SWEEP_INTERVAL_MS)
    sweepTimer.unref() // do not keep the event loop alive for housekeeping
    void sweepExpiredSessions() // clear anything stale left from a previous run

    httpServer.listen(port, () => {
      console.log(`> Ready on http://localhost:${port} [${dev ? 'dev' : 'production'}]`)
    })
  })
  .catch((err) => {
    // P1: Next.js startup failures (compilation error, missing build output in production)
    console.error('[server] Failed to start Next.js:', err)
    process.exit(1)
  })
