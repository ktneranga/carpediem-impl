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
  lines: TicketLine[]
}

/**
 * `printer:alert` — a job gave up after its retries (Story 5.0, AC-6).
 *
 * Owner room only. It names tables and carries enough to find the job, and the
 * ticket behind it holds guests' seat notes.
 *
 * This is NOT the old "printer failed, reprint manually" banner. The job is
 * still in the table and still recoverable; what the alert means is "the queue
 * has stopped trying on its own" (Change U3).
 */
export type PrinterAlertPayload = {
  jobId: string
  destination: ProductionDestination
  tableLabels: string[]
  attempts: number
  lastError: string
}
