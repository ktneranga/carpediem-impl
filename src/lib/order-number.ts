/**
 * How an order number reads (Teran, 2026-11-02).
 *
 * Two forms of ONE stored fact — the business date and the day's number,
 * assigned by the database when the order opens (migration 0032):
 *
 * - `#042`          — the floor and the kitchen: short enough to shout, and
 *                     restarts every business day.
 * - `20261102-042`  — unique for ever: the dashboard, past orders, a dispute.
 *
 * Padded to three digits; a day past 999 orders simply prints four.
 */
export function dailyOrderLabel(dailyNumber: number): string {
  return `#${String(dailyNumber).padStart(3, '0')}`
}

/** `businessDate` as stored: `YYYY-MM-DD`. */
export function orderReference(businessDate: string, dailyNumber: number): string {
  return `${businessDate.replaceAll('-', '')}-${String(dailyNumber).padStart(3, '0')}`
}
