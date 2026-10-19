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

/**
 * A price held in integer paisa, rendered without lying about it.
 *
 * `lkr()` above takes RUPEES and rounds, which is right for totals on a bill —
 * a bill that displays 18,400 and charges 18,399 is an audit discrepancy, so the
 * rounding happens once, at the point the amount is decided.
 *
 * A MENU PRICE is different: it is already exact, in paisa, and nothing rounds
 * it before the guest is charged. Passing `paisa / 100` into `lkr()` showed
 * `LKR 951` for an item priced 95050 — fifty paisa more than the card promised,
 * on every line of the bill. Nothing constrains `price_paisa` to whole rupees,
 * so this renders the decimals when there are any and stays clean when there
 * are not.
 */
export function lkrFromPaisa(paisa: number): string {
  const rupees = Math.trunc(paisa / 100)
  const remainder = Math.abs(paisa % 100)
  const whole = rupees.toLocaleString('en-US')
  return remainder === 0 ? `LKR ${whole}` : `LKR ${whole}.${String(remainder).padStart(2, '0')}`
}

/**
 * Title for a merged group of tables: `B2 + B3`, then `Table 1 +2`.
 *
 * A pair spells both out, because that is the common case and `B2 + B3` is the
 * thing a waiter actually says out loud. Past two the labels stop fitting a card
 * band sized for `R03` — this project's own seed uses labels as long as
 * `Table 1`, and `Table 1+Table 2+Table 3` is twenty-two characters — so the
 * title degrades to a count and the full list moves into the card body.
 *
 * Never returns an empty string for a real group; a one-table "group" is just
 * that table, which is what an unmerged session is.
 */
export function mergedTitle(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`
  return `${labels[0]} +${labels.length - 1}`
}

/**
 * Wall-clock time as staff say it: `2:05 pm`.
 *
 * Fixed to `en-US` rather than the browser locale, deliberately. This string is
 * an IDENTITY — it is how a counter sale is named and how one waiter tells
 * another which order they mean — so it must read identically on every device in
 * the restaurant. A tablet with a different locale showing `14:05` for the order
 * everyone else calls `2:05 pm` is a conversation that goes wrong at the pass.
 */
export function clockTime(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
}

/** Quantity is always `3×`, never `x3` or a bare number. */
export function quantity(count: number): string {
  return `${count}×`
}
