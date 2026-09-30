/**
 * Nudging the print queue from inside Next (Story 5.0, Task 5).
 *
 * ── Why a global, not an import ──────────────────────────────────────────────
 * The worker is started by `server.ts`, which is outside Next's module graph;
 * a Route Handler cannot import from it, and importing the worker directly from
 * a handler would give Next its own second copy with its own pool and its own
 * timer. `server.ts` publishes one function on the global instead — exactly
 * what it already does with `global.__io` for Socket.io.
 *
 * ── It is an optimisation, never the mechanism ───────────────────────────────
 * Skipping this call costs a ticket up to one tick (3s) of delay and nothing
 * else. The timer in `server.ts` is what guarantees delivery, including for the
 * jobs nobody is around to nudge — the backlog a printer left behind while the
 * restaurant was quiet.
 */

declare global {
  var __wakePrintQueue: (() => void) | undefined
}

/** Asks the worker to drain now. Safe to call when nothing is listening. */
export function wakePrintQueue(): void {
  try {
    globalThis.__wakePrintQueue?.()
  } catch (error) {
    // The round is committed and the job is queued; the tick will find it.
    console.error('[print] Could not wake the queue:', error)
  }
}
