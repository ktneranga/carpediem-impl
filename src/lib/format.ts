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
 * A glance-value for a floor card: `LKR 4.3k`.
 *
 * ── Why a second money formatter ────────────────────────────────────────────
 * `lkrFromPaisa` is exact because a bill that displays one number and charges
 * another is an audit discrepancy. A table card is not a bill: nobody
 * reconciles against it, and the waiter reading it from three metres away
 * needs the MAGNITUDE, not the rupees. "LKR 4.3k" fits the card; "LKR 4,350"
 * does not, and truncating it with an ellipsis would be worse than rounding.
 *
 * Rounded DOWN, never up, and never to zero: a card must not flatter what a
 * table owes. The exact figure is on the order screen, one tap away, and the
 * card's accessible name reads it in full.
 */
export function lkrCompact(paisa: number): string {
  const rupees = paisa / 100
  if (rupees < 1000) return `LKR ${Math.floor(rupees).toLocaleString('en-LK')}`
  // floor to one decimal: 4,350 -> 4.3k, never 4.4k.
  return `LKR ${(Math.floor(rupees / 100) / 10).toFixed(1)}k`
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
 * A rate in basis points as a percentage: 1000 → "10", 250 → "2.5".
 *
 * Shared by the bill screen and the printed bill (Story 6.6), so the paper and
 * the screen cannot word the same rate two ways.
 */
export function percentFromBp(bp: number): string {
  // Two decimals, trailing zeros dropped: 1225 bp is "12.25", not "12.3" —
  // a rate printed on a legal bill must agree with the tax beside it.
  return (bp / 100).toFixed(2).replace(/\.?0+$/, '')
}

/**
 * A price CHANGE, signed — "+LKR 1,000", "−LKR 1,000" (a true minus, U+2212),
 * and "" for no change (Story 4.8: an option's effect on the dish).
 *
 * Not `lkrFromPaisa`, which prints a negative as "LKR -1,000" with a hyphen;
 * not `deduction`, which takes rupees and drops the currency.
 */
export function signedLkrFromPaisa(deltaPaisa: number): string {
  if (deltaPaisa === 0) return ''
  const sign = deltaPaisa > 0 ? '+' : '−'
  return `${sign}${lkrFromPaisa(Math.abs(deltaPaisa))}`
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
