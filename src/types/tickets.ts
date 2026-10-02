/**
 * Print-queue types, shared by three callers that cannot share much else.
 *
 * `order.service.ts` builds a payload (inside Next, `server-only`), the worker
 * reads one (loaded from `server.ts`, where `server-only` THROWS), and the
 * schema types the `jsonb` column. So this module imports nothing but other
 * neutral types — the same rule `src/types/orders.ts` and
 * `src/server/socket/rooms.ts` follow, for the same reason.
 */
import type { ProductionDestination, TicketLine } from '@/types/orders'

/**
 * One ticket, as the queue stores it.
 *
 * ── Self-contained on purpose ────────────────────────────────────────────────
 * Everything the paper needs is COPIED in at enqueue time. A job printed six
 * minutes late — the printer was out of paper — must produce the header the
 * order had when it was sent, not the one its session has now. Between those
 * two moments the session can be merged, un-merged, re-seated or closed, so
 * storing ids and re-reading at print time would print a header that never
 * existed. The audit trail is `order_events`; this is the rendering of it.
 */
export type TicketPayload = {
  /** KOT / KOT-P / BOT is derived from this, in Story 5.2. */
  destination: ProductionDestination
  roundNumber: number
  /**
   * Every table on the session in label order, or `['COUNTER']` when it has
   * none (FR18: "or the label `COUNTER` where the session has no table").
   */
  tableLabels: string[]
  /** False outside the Tables zone: the ticket prints no seat headers. */
  usesSeats: boolean
  /** ISO. The committed round's `submitted_at` — PostgreSQL's clock, not Node's. */
  submittedAt: string
  /**
   * The restaurant's IANA zone, from `tenants.timezone` (e.g. `Asia/Colombo`).
   *
   * OPTIONAL, and it must stay optional: the queue holds jobs across deploys,
   * so a ticket written before this field existed still has to print. Those
   * fall back to the process timezone, which is what they would have used
   * anyway. Copied in at enqueue rather than read at print time for the same
   * reason as everything else here — the job must stand alone.
   *
   * `src/server/time.ts` has the argument in full: correctness must not depend
   * on whether `TZ` was set on the host.
   */
  timeZone?: string
  lines: TicketLine[]
}

/**
 * `printer:alert` — a ticket is having trouble reaching its printer.
 *
 * ── Two kinds, and the difference is the whole point (Change U3) ─────────────
 * `retrying` is informational: the queue is still working on it and will
 * probably succeed. `dead` means it has stopped trying and someone has to look.
 * The old design had one banner meaning "failed, reprint manually" — manual
 * reprint is no longer the recovery mechanism, and a banner that cannot tell
 * those apart trains staff to ignore both.
 *
 * ── Broadcast to every authenticated device (Story 5.2) ─────────────────────
 * Story 5.0 sent this to the owner room, reasoning that a ticket carries
 * guests' seat notes. This payload carries none — no dish, no seat, no note,
 * just which station and which tables. The people who can act on a dead ticket
 * are the waiter who sent it and whoever is near the kitchen; the owner room
 * also has no members until Epic 9, so owner-only reached nobody at all.
 */
export type PrinterAlertPayload = {
  /**
   * `retrying` — still working on it, asks nothing of anybody.
   * `dead` — stopped trying, needs attention.
   * `recovered` — a ticket that had been failing has now printed. Without
   *   this third kind there was no signal that ever cleared a banner, so one
   *   transient failure left "the printer is not responding" on every device
   *   for the rest of service.
   */
  kind: 'retrying' | 'dead' | 'recovered'
  jobId: string
  destination: ProductionDestination
  tableLabels: string[]
  attempts: number
  lastError: string
}
