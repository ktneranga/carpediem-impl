'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { io, type Socket } from 'socket.io-client'

/**
 * Shared Socket.io connection.
 *
 * ONE socket per browser tab, module-level and lazily created. Multiple
 * components will subscribe as Epics 4 and 5 land (kitchen display, order
 * screen, owner dashboard); each opening its own connection would multiply
 * connections per device for no benefit.
 *
 * Connects to the same origin — server.ts attaches Socket.io to the same HTTP
 * server on port 3000, so no URL configuration is needed.
 */
let sharedSocket: Socket | undefined

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io({
      // Socket.io reconnects by default; these just make the behaviour explicit
      // and bounded rather than relying on library defaults staying put.
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
    })
  }
  return sharedSocket
}

/**
 * Tears down the shared connection. Sign-out only.
 *
 * The socket is a module singleton that deliberately survives component
 * unmounts, so nothing else closes it — which meant a connection opened under
 * one staff member's session stayed open after they signed out. The next
 * `getSocket()` call creates a fresh one.
 */
export function disconnectSocket(): void {
  sharedSocket?.disconnect()
  sharedSocket = undefined
}

/**
 * Subscribes to one Socket.io event for the lifetime of the component.
 *
 * The handler is held in a ref so the effect does not re-run — and therefore
 * does not re-register the listener — every time the parent re-renders with a
 * new inline callback. Re-registering is how handlers end up firing twice.
 */
export function useSocketEvent<T>(eventName: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler)

  // Assigned in an effect, not during render. Mutating a ref while rendering
  // breaks React's purity rule (react-hooks/refs) and can leave the ref stale
  // when a render is discarded.
  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    const socket = getSocket()
    const listener = (payload: T) => handlerRef.current(payload)

    socket.on(eventName, listener)

    return () => {
      // Remove only THIS listener. The shared socket stays connected — other
      // components may still be using it, and reconnecting on every unmount
      // would thrash the connection during normal navigation.
      socket.off(eventName, listener)
    }
  }, [eventName])
}

function subscribeToStatus(onChange: () => void): () => void {
  const socket = getSocket()
  socket.on('connect', onChange)
  socket.on('disconnect', onChange)

  return () => {
    socket.off('connect', onChange)
    socket.off('disconnect', onChange)
  }
}

function getStatusSnapshot(): boolean {
  return sharedSocket?.connected ?? false
}

function getServerStatusSnapshot(): boolean {
  return false
}

/**
 * Live connection status, for showing a degraded-state indicator.
 *
 * `useSyncExternalStore` rather than useState + useEffect: the socket IS an
 * external store, and seeding state from an effect trips
 * `react-hooks/set-state-in-effect` and costs an extra render.
 */
export function useSocketStatus(): boolean {
  return useSyncExternalStore(subscribeToStatus, getStatusSnapshot, getServerStatusSnapshot)
}

/**
 * Joins a server room for the lifetime of the component, and again after every
 * reconnect (Story 4.5).
 *
 * A room belongs to one connection. When the socket drops and reconnects it is
 * a NEW connection on the server, in no rooms at all — so a join sent once on
 * mount would silently stop delivering after the first Wi-Fi blip. The join is
 * therefore re-sent on every `connect`.
 *
 * The server decides whether the join is allowed (`registerRoomHandlers` in
 * `src/server/socket/authenticate.ts`) and answers through the ack; a refused
 * join is logged and otherwise ignored, because the screen still works — it
 * just learns about other devices' changes on its next refetch.
 *
 * `args` is compared by value (serialised), so an inline object literal does
 * not re-join on every render.
 */
export function useSocketRoom(command: string, args?: Record<string, unknown>): void {
  const argsKey = JSON.stringify(args ?? null)

  useEffect(() => {
    const socket = getSocket()
    const payload = JSON.parse(argsKey) as Record<string, unknown> | null
    const onReply = (reply: { ok?: boolean; error?: string } | undefined) => {
      if (!reply?.ok) console.warn(`[socket] ${command} refused:`, reply?.error ?? 'no reply')
    }
    const join = () => {
      if (payload) socket.emit(command, payload, onReply)
      else socket.emit(command, onReply)
    }

    if (socket.connected) join()
    socket.on('connect', join)

    return () => {
      socket.off('connect', join)
    }
  }, [command, argsKey])
}
