import 'server-only'
import type { Server } from 'socket.io'

declare global {
  // eslint-disable-next-line no-var
  var __io: Server | undefined
}

export function getIO(): Server {
  if (!global.__io) {
    throw new Error(
      '[socket.io] Server not initialized — server.ts must start before any Route Handler calls getIO()'
    )
  }
  return global.__io
}
