import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server } from 'socket.io'

const dev = process.env.NODE_ENV !== 'production'
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

    httpServer.listen(port, () => {
      console.log(`> Ready on http://localhost:${port} [${dev ? 'dev' : 'production'}]`)
    })
  })
  .catch((err) => {
    // P1: Next.js startup failures (compilation error, missing build output in production)
    console.error('[server] Failed to start Next.js:', err)
    process.exit(1)
  })
