/**
 * Money and numeral formatters — Carpe Diem RMS Design System v1.0.
 *
 * These are the system's own exported formatters. Nothing should hand-roll
 * currency or elapsed time: the rules below are what stop totals shimmering as
 * they tick and what keeps LKR consistent across tickets, bills and dashboards.
 */

/**
 * LKR with thousands separators, never decimals: `LKR 18,400`.
 *
 * Amounts are rounded, not truncated — a bill that displays 18,400 and charges
 * 18,399 is an audit discrepancy, and this system's whole premise is the audit
 * trail. Callers holding sub-rupee precision should round before persisting.
 */
export function lkr(amount: number): string {
  return `LKR ${Math.round(amount).toLocaleString('en-US')}`
}

/** A deduction carries a true minus, not a hyphen: `− 2,400`. */
export function deduction(amount: number): string {
  return `− ${Math.round(Math.abs(amount)).toLocaleString('en-US')}`
}

/**
 * Elapsed time: `67 min` under an hour, `1h 07m` at or over it.
 *
 * The switch at 60 is deliberate. Minutes stay a single scannable number for
 * the whole of a normal sitting; the h/m form appears exactly when a table has
 * been running long enough that a waiter should look twice.
 */
export function elapsed(minutes: number): string {
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `${hours}h ${String(remainder).padStart(2, '0')}m`
}

/** Quantity is always `3×`, never `x3` or a bare number. */
export function quantity(count: number): string {
  return `${count}×`
}
