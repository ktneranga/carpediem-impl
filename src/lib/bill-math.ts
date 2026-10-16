/**
 * Bill arithmetic, shared by the server and the order screen.
 *
 * ── Why this is not in `bill.service.ts` ─────────────────────────────────────
 * It was, and it could not stay there. `bill.service.ts` is `server-only`, and
 * the 2026-10-16 order-entry design puts "Service 10%" and "Table total" on
 * the waiter's screen — the same figures the bill will charge. That left two
 * options: compute them a second time on the client, or move the one
 * implementation somewhere both sides can reach.
 *
 * Story 6.2's AC-10 exists precisely to forbid the first. A seat bill and a
 * consolidated bill disagreeing about a service charge would be caught by
 * nothing, and an order screen that previews a different total from the bill
 * it is previewing is the same defect pointed at the guest.
 *
 * So the function moved. It is pure arithmetic over integers — no database, no
 * secrets, nothing that wants `server-only`.
 *
 * ── This file must stay pure ─────────────────────────────────────────────────
 * No imports from `@/server`, no Drizzle, no `process.env`. The moment it
 * needs any of those it belongs back behind the server boundary, and the
 * client goes back to asking the server for a preview.
 */
import type { BillTotals } from '@/types/bills'

/**
 * The money, computed in ONE place (AC-2).
 *
 * ── Why a pure function, exported ────────────────────────────────────────────
 * Story 6.4 (per-seat bills) and 6.5 (payments) both need these numbers. If
 * each computed them itself, a seat bill and a consolidated bill for the same
 * table could disagree about the service charge and nothing would catch it.
 * There is one implementation and callers hand it a subtotal.
 *
 * ── Round ONCE, never per line ───────────────────────────────────────────────
 * Rounding each line and summing produces a bill that disagrees with its own
 * arithmetic by a few paisa, which the guest notices before you do. Each of the
 * two roundings below happens on a single whole-bill figure.
 *
 * ── Order matters ────────────────────────────────────────────────────────────
 * Service is on the subtotal; tax is on subtotal + service. Reversing them is a
 * different total.
 *
 * ── `hasTableService`, not `kind` ────────────────────────────────────────────
 * The caller decides this from the session's ATTACHED TABLES. See
 * `collectBillable` for why `order_sessions.kind` is the wrong input (AC-3).
 *
 * Basis points: 1000 = 10.00%. `taxBp` is derived from the integer
 * `tax_rate_percent` by the caller — see `readRates`.
 */
export function computeBillTotals({
  subtotalPaisa,
  serviceChargeBp,
  taxBp,
  hasTableService,
}: {
  subtotalPaisa: number
  serviceChargeBp: number
  taxBp: number
  hasTableService: boolean
}): BillTotals {
  const appliedServiceBp = hasTableService ? serviceChargeBp : 0
  const serviceChargePaisa = Math.round((subtotalPaisa * appliedServiceBp) / 10_000)
  const taxPaisa = Math.round(((subtotalPaisa + serviceChargePaisa) * taxBp) / 10_000)

  return {
    subtotalPaisa,
    serviceChargePaisa,
    taxPaisa,
    totalPaisa: subtotalPaisa + serviceChargePaisa + taxPaisa,
    // The rates APPLIED, not the rates configured. A counter sale stores 0, so
    // the bill explains why it has no service line without anyone having to
    // know what the tenant's rate was that evening.
    serviceChargeBp: appliedServiceBp,
    taxBp,
  }
}
