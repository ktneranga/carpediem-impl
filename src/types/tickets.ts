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
  /**
   * The OTHER stations this round went to — a kitchen ticket printed with
   * "SERVE WITH: KOT-P + BOT" so each station knows the table's food is coming
   * from more than one place and goes out together (Teran, 2026-11-02). Names
   * only, never the other stations' items: those waste the roll. Optional — a
   * job queued before this field existed prints without the line.
   */
  alsoFor?: ProductionDestination[]
  /**
   * The order number (Teran, 2026-11-02): `dailyNumber` prints as `#042` in the
   * header, and with `businessDate` (`YYYY-MM-DD`) as `Order 20261102-042` at
   * the foot. Optional — a job queued before the number existed prints
   * without it.
   */
  dailyNumber?: number
  businessDate?: string
  lines: TicketLine[]
}

/**
 * Where a print job goes (Story 6.6): a production station, or `cashier` — the
 * receipt printer, for bills. Mirrors `print_destination` in the schema.
 */
export type PrintDestination = ProductionDestination | 'cashier'

/** One line on a guest's bill, as printed. */
export type ReceiptLine = {
  quantity: number
  name: string
  /** quantity × unit price, integer paisa. */
  amountPaisa: number
  /** "Extra shot ×2, No ice" — the options it was sent with. */
  optionText: string | null
  /** The waiter's note — "extra spicy". FR69 prints it. */
  modifierText: string | null
}

/**
 * A guest's bill or receipt, as the queue stores it (Story 6.6, FR69).
 *
 * Self-contained for the same reason as `TicketPayload`: everything the paper
 * shows is COPIED in when the waiter taps Print, so a job printed late shows
 * the bill as it was, not as the session has become. Every amount was priced
 * by the server (`priceBillable`, or the stored bill) — never by the client.
 *
 * Carries `destination` and `tableLabels` because the worker reads both from
 * any job to raise `printer:alert`.
 *
 * Guest-facing: no seat note and no tab nickname ever reach this payload.
 */
export type ReceiptPayload = {
  kind: 'receipt'
  destination: 'cashier'
  /** BILL until fully paid, RECEIPT once it is. */
  title: 'BILL' | 'RECEIPT'
  /** A recorded bill printed again — "COPY" under the title. */
  copy: boolean
  restaurantName: string
  /**
   * `tenant_config.receipt_header` / `receipt_footer`, one entry per line
   * (an address and a phone number are two lines). Empty prints nothing.
   */
  headerLines: string[]
  footerLines: string[]
  /**
   * Printed as a QR code under the footer (`tenant_config.receipt_qr_url`).
   * Optional: jobs queued before it existed have none.
   */
  qr?: { url: string; caption: string | null } | null
  /** `tenant_config.receipt_logo`: a 1-bit raster printed above the name. */
  logo?: { widthDots: number; heightDots: number; data: string } | null
  /** Who printed it, or who took the payment it follows ("Cashier: Nina"). */
  cashierName?: string | null
  /** Every table on the order, or `['Bar tab']` / `['COUNTER']`. */
  tableLabels: string[]
  /** "Seat 1", "Person 2" or "Split bill" when the bill covers part of the table. */
  billLabel: string | null
  /** ISO. The database clock when Print was tapped. */
  printedAt: string
  timeZone?: string
  dailyNumber: number
  /** `YYYY-MM-DD`. */
  businessDate: string
  lines: ReceiptLine[]
  /** Negative paisa each. Nothing writes comps before Story 7.3. */
  comps: { reason: string; amountPaisa: number }[]
  subtotalPaisa: number
  serviceChargePaisa: number
  serviceChargeBp: number
  taxPaisa: number
  taxBp: number
  totalPaisa: number
  /** What has been paid, oldest first. Empty on an unpaid bill. */
  tenders: { method: 'cash' | 'card' | 'transfer'; amountPaisa: number; cashReceivedPaisa: number | null }[]
}

/**
 * Anything on the print queue. A stored job with no `kind` is a ticket — every
 * job written before Story 6.6 — and must keep printing as one.
 */
/**
 * Open the cash drawer (Story 6.7, FR72). The drawer hangs off the receipt
 * printer's DK port, so the kick is a `cashier` job like a bill: one queue,
 * kept in order, so a kick queued before the receipt opens first.
 *
 * `tableLabels` is `['Cash drawer']` because the worker reads it from ANY job to
 * name the job in a `printer:alert`.
 */
export type DrawerKickPayload = {
  kind: 'drawer'
  destination: 'cashier'
  tableLabels: string[]
  opening: 'sale' | 'no_sale'
}

export type PrintPayload = TicketPayload | ReceiptPayload | DrawerKickPayload

/** Whether a stored payload is a receipt. A job with no `kind` is a ticket. */
export function isReceiptPayload(payload: PrintPayload): payload is ReceiptPayload {
  return (payload as { kind?: unknown }).kind === 'receipt'
}

/** Whether a stored payload is a cash-drawer kick (Story 6.7). */
export function isDrawerKickPayload(payload: PrintPayload): payload is DrawerKickPayload {
  return (payload as { kind?: unknown }).kind === 'drawer'
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
  /** `cashier` is the bill printer (Story 6.6). */
  destination: PrintDestination
  tableLabels: string[]
  attempts: number
  lastError: string
}
