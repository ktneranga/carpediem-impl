import 'server-only'
import { db } from '@/server/db'
import { sessionPaymentState } from '@/server/services/payment.service'
import { emitCounterSalesChanged, emitSessionPaymentChanged } from '@/server/socket/events'

/**
 * Tells the floor where an order now stands with its money, after the commit.
 *
 * A failure here never fails the request: the write already happened, and the
 * floor refetches on its next load. One copy, for every route that moves money
 * (payments, bill & split, seat bill).
 */
export async function announcePayment(sessionId: string): Promise<void> {
  try {
    emitSessionPaymentChanged({ sessionId, paymentState: await sessionPaymentState(db, sessionId) })
    // Bar tabs are a list query, refreshed by this event (payload-free).
    emitCounterSalesChanged()
  } catch (error) {
    console.error('[payment-announce] Could not announce the payment state:', error)
  }
}
