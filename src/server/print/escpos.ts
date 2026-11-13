/**
 * ESC/POS ticket bytes (Story 5.2, Task 1).
 *
 * ── What ESC/POS is, in one paragraph ────────────────────────────────────────
 * A thermal printer is a byte sink. It prints anything it does not recognise as
 * a command, and commands are short escape sequences: `1B 40` resets it, `1B 45
 * 01` turns bold on, `1D 56 42 03` cuts the paper. There is no layout engine —
 * columns are spaces, alignment is a command, and a line is 48 characters wide
 * because that is how many fit. Everything below is that, and nothing else.
 *
 * ── No `server-only`, and no library ─────────────────────────────────────────
 * The worker that calls this is loaded from `server.ts`, outside Next's module
 * graph, where `server-only` throws at import time — the whole reason
 * `src/server/print/` exists. And a printing library would be a dependency for
 * about forty bytes of constants; Story 5.0's "no new dependencies" note
 * applies here too.
 *
 * Pure: no I/O, no configuration, no clock beyond the timestamp it is handed.
 * `escpos-transport.ts` owns the socket.
 */
import { lkrFromPaisa, percentFromBp } from '@/lib/format'
import { dailyOrderLabel, orderReference } from '@/lib/order-number'
import {
  isDrawerKickPayload,
  isReceiptPayload,
  isTakingsPayload,
  type PrintPayload,
  type ReceiptPayload,
  type TakingsPayload,
  type TicketPayload,
} from '@/types/tickets'
import type { TicketLine } from '@/types/orders'

// ── Commands ────────────────────────────────────────────────────────────────
const ESC = 0x1b
const GS = 0x1d

/** `ESC @` — reset. Clears whatever state the last ticket left behind. */
const INIT = [ESC, 0x40]
/** `ESC a n` — 0 left, 1 centre. */
const ALIGN_LEFT = [ESC, 0x61, 0]
const ALIGN_CENTRE = [ESC, 0x61, 1]
/** `ESC E n` — bold. */
const BOLD_ON = [ESC, 0x45, 1]
const BOLD_OFF = [ESC, 0x45, 0]
/** `GS ! n` — character size; the nibbles are width and height multipliers. */
const SIZE_NORMAL = [GS, 0x21, 0x00]
const SIZE_DOUBLE = [GS, 0x21, 0x11]
/** Double HEIGHT only — keeps the 48-column width, so a right-aligned amount stays aligned. */
const SIZE_TALL = [GS, 0x21, 0x01]
/** `ESC d n` — feed n LINES. The subtask that asked for this was ticked before
 *  it was written; the cut below is why it is needed. */
const feedLines = (lines: number) => [ESC, 0x64, lines]
/**
 * `GS V 66 n` — partial cut, after feeding n VERTICAL MOTION UNITS.
 *
 * Motion units, not lines: one is about 0.125mm, so the `3` this used to pass
 * fed 0.4mm. The blade sits 10–20mm above the print head on every thermal
 * unit, so the last several lines of every ticket — the items — ended up above
 * the tear point and were cut through or left attached to the next ticket. The
 * comment said "feeding n lines first so the cut clears the text", which is
 * what the code now actually does, via `feedLines` before this.
 */
const CUT = [GS, 0x56, 66, 0x00]

/**
 * `GS v 0` — a 1-bit raster image (the logo). Null when the stored image is
 * not a well-formed raster that fits the 80mm head (576 dots), so a bad
 * setting prints no logo instead of a page of garbage.
 */
function rasterImage(image: { widthDots: unknown; heightDots: unknown; data: unknown }): number[] | null {
  const { widthDots: width, heightDots: height, data } = image
  if (typeof width !== 'number' || typeof height !== 'number' || typeof data !== 'string') return null
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || width > 576 || width % 8 !== 0) return null
  if (height <= 0 || height > 600) return null
  const bytes = Buffer.from(data, 'base64')
  const rowBytes = width / 8
  if (bytes.length !== rowBytes * height) return null
  return [GS, 0x76, 0x30, 0, rowBytes & 0xff, rowBytes >> 8, height & 0xff, height >> 8, ...bytes, 0x0a]
}

/**
 * `GS ( k` — the printer draws a QR code itself (Teran, 2026-11-12): model 2,
 * 6-dot modules (about 25mm for a short link), error correction M, store the
 * data, then print it. No image library; `url` is printable ASCII already.
 */
function qrCode(url: string): number[] {
  const data = Buffer.from(url, 'ascii')
  const stored = data.length + 3
  return [
    GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00, // model 2
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6, // module size
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31, // error correction M
    GS, 0x28, 0x6b, stored & 0xff, stored >> 8, 0x31, 0x50, 0x30, ...data, // store
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, // print
    0x0a,
  ]
}

/**
 * Characters per line at Font A.
 *
 * 48 is 80mm paper, the common kitchen size. A 58mm roll is 32 — change this
 * one constant and every line below re-wraps, which is why nothing else in this
 * file hardcodes a width.
 *
 * Not verified against a real printer: no hardware exists on this project yet.
 */
export const PAPER_COLUMNS = 48

/**
 * Anything that is not printable ASCII, made printable (AC-8).
 *
 * A thermal printer does not render an unknown byte as a box — it interprets it.
 * A stray `0xD7` (the `×` this app already uses for quantities) can switch the
 * code page for the rest of the ticket, or be read as the start of a command.
 * Control bytes are already stripped at enqueue (`ticket.ts`, Story 5.0); this
 * is the other half of the guard, at the byte layer, because a dish name will be
 * owner-editable from Epic 10 and nothing downstream of here can rescue it.
 *
 * Fold, do not fail: `×` → `x`, `é` → `e`, a dash → a hyphen. Anything with no
 * sensible ASCII equivalent is dropped rather than replaced with a marker — a
 * line of `???` tells the kitchen nothing it can act on.
 */
const FOLD: Record<string, string> = {
  '×': 'x',
  '·': '-',
  '—': '-',
  // U+2212, the true minus `deduction` and the signed formatters use. Without
  // it the strip below deleted the sign, and a comp printed as a charge.
  '−': '-',
  '–': '-',
  '‑': '-',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '…': '...',
  '₨': 'Rs',
  '€': 'EUR',
  '£': 'GBP',
  // ── Vulgar fractions, mapped BEFORE normalisation ─────────────────────────
  // NFKD decomposes `½` into `1`, U+2044 FRACTION SLASH, `2`. The slash is not
  // a combining mark, so the strip below deleted it and left `12`: a half
  // chicken printed as twelve chickens, silently, on the one field that has to
  // be exact. Half and quarter portions are ordinary menu wording.
  '½': '1/2',
  '⅓': '1/3',
  '⅔': '2/3',
  '¼': '1/4',
  '¾': '3/4',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
}

/**
 * Printable ASCII, or null when nothing survives.
 *
 * Takes `unknown`, not `string`: the payload comes out of a `jsonb` column that
 * may have been written by an older version of this code, and a null `name`
 * used to throw `TypeError: text is not iterable` from inside `deliver()` —
 * which burned all six attempts, head-of-line blocked the station for a minute
 * and a half, and showed staff "text is not iterable" on the alert.
 */
export function foldToAscii(text: unknown): string {
  if (typeof text !== 'string') return ''
  const mapped = [...text].map((character) => FOLD[character] ?? character).join('')
  return (
    mapped
      // NFKD splits an accented letter into its base plus a combining mark, and
      // the first range below is those marks: "é" becomes "e", not nothing.
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      // U+2044 survives NFKD and is not a combining mark. Any fraction the
      // table above missed still reads as a fraction rather than fusing.
      .replace(/⁄/g, '/')
      .replace(/[^\x20-\x7e]/g, '')
  )
}

/**
 * A name for the ticket, never an empty one.
 *
 * A dish named in Sinhala or Tamil folds to nothing — those scripts have no
 * NFKD decomposition — and the line printed as `2 x` with no dish at all. This
 * is a Sri Lankan restaurant and menu names become owner-editable in Epic 10,
 * so that is a reachable way to send the kitchen a ticket it cannot read AND
 * cannot tell is broken. A visible marker is worse than the name and far
 * better than silence; Story 5.2's successor should carry a transliteration.
 */
function printableName(value: unknown): string {
  const folded = foldToAscii(value).trim()
  return folded === '' ? '[name not printable]' : folded
}

/**
 * Wraps to the paper width, continuing under an indent (AC-9).
 *
 * Truncating loses the end of a dish name, which on a ticket is the difference
 * between two dishes. A word longer than the line is broken rather than allowed
 * to run off the roll.
 */
export function wrapLine(text: string, indent = 0, columns = PAPER_COLUMNS): string[] {
  const width = Math.max(1, columns - indent)
  const pad = ' '.repeat(indent)
  const out: string[] = []
  let current = ''

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === '') {
      current = word
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`
    } else {
      out.push(pad + current)
      current = word
    }
    while (current.length > width) {
      out.push(pad + current.slice(0, width))
      current = current.slice(width)
    }
  }
  if (current !== '') out.push(pad + current)
  return out.length > 0 ? out : [pad]
}

/**
 * Items under their seat, in first-appearance order.
 *
 * Shared with `renderTicketText` so the paper and the log cannot drift — the
 * two used to be separate loops with the same intent, which is how they start
 * disagreeing about what a ticket says.
 */
export function groupBySeat(lines: TicketLine[]): Map<string, TicketLine[]> {
  const bySeat = new Map<string, TicketLine[]>()
  for (const line of lines) {
    // `?? 'Seat'` rather than trusting the stored row: a null `seatLabel` used
    // to become a `null` map key and print as "null".
    const label = typeof line.seatLabel === 'string' && line.seatLabel !== '' ? line.seatLabel : 'Seat'
    const header = line.seatNote ? `${label} (${line.seatNote})` : label
    const existing = bySeat.get(header)
    if (existing) existing.push(line)
    else bySeat.set(header, [line])
  }
  return bySeat
}

/**
 * "SERVE WITH: KOT-P + BOT", or null when the round went to this station
 * alone. Guarded like every stored field: a job from before `alsoFor` existed,
 * or a malformed one, prints without the line.
 */
export function serveWithLine(ticket: TicketPayload): string | null {
  const known = ['kitchen', 'pizza_kitchen', 'bar'] as const
  const others = (Array.isArray(ticket.alsoFor) ? ticket.alsoFor : []).filter(
    (other) => (known as readonly unknown[]).includes(other) && other !== ticket.destination,
  )
  if (others.length === 0) return null
  return `SERVE WITH: ${[...new Set(others)].map(ticketTypeOf).join(' + ')}`
}

/** The day's order number, or null for a job queued before it existed. */
function orderNumberOf(ticket: TicketPayload): number | null {
  return Number.isInteger(ticket.dailyNumber) && ticket.dailyNumber! > 0 ? ticket.dailyNumber! : null
}

/**
 * "02 Nov 2026", in the restaurant's zone — the same rules as `clockTime`:
 * pinned locale, the tenant's zone when the job carries it, and a placeholder
 * rather than "Invalid Date" for a malformed timestamp.
 */
export function calendarDate(iso: string, timeZone?: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '--'
  const options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(when)
  } catch {
    // An unknown zone string must not stop a ticket printing.
    return new Intl.DateTimeFormat('en-GB', options).format(when)
  }
}

/** KOT / KOT-P / BOT (FR14–FR16). */
export function ticketTypeOf(destination: TicketPayload['destination']): string {
  if (destination === 'pizza_kitchen') return 'KOT-P'
  if (destination === 'bar') return 'BOT'
  return 'KOT'
}

/**
 * "2:34 PM" (AC-2), in the RESTAURANT's timezone.
 *
 * ── Why the zone is a parameter ──────────────────────────────────────────────
 * This used to read the Node process's timezone via `getHours()`.
 * `src/server/time.ts` exists specifically to forbid that, and says why:
 * "correctness must not depend on deployment configuration… The timezone is a
 * property of the restaurant, so it is read from the restaurant."
 * `docker-compose.yml` sets `TZ`, but a second host, a bare `node server.js` or
 * a dropped env var puts the process in UTC — and a round sent at 2:34 PM in
 * Colombo would print `9:04 AM`, on the one artefact a cook compares against
 * the clock on the wall.
 *
 * `tenants.timezone` (seeded `Asia/Colombo`) is copied into the ticket at
 * enqueue. It is OPTIONAL on the payload, because the queue may still hold jobs
 * written before this field existed — Trap 6 — and those fall back to the
 * process zone, which is what they would have printed anyway.
 *
 * NOT `toLocaleTimeString()` with no arguments: that reads the host's locale,
 * so the same ticket could print "2:34 PM" here and "14:34" there. The locale
 * is pinned; only the zone varies.
 */
export function clockTime(iso: string, timeZone?: string): string {
  const when = new Date(iso)
  // A malformed or missing timestamp used to print "NaN:NaN PM", which the
  // kitchen reads as a broken printer rather than broken data.
  if (Number.isNaN(when.getTime())) return '--:--'

  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone,
      }).format(when)
    } catch {
      // An unknown zone string must not stop a ticket printing.
    }
  }

  const hours = when.getHours()
  const minutes = when.getMinutes().toString().padStart(2, '0')
  const suffix = hours < 12 ? 'AM' : 'PM'
  const twelve = hours % 12 === 0 ? 12 : hours % 12
  return `${twelve}:${minutes} ${suffix}`
}

/**
 * One ticket, as the bytes a printer will accept.
 *
 * Reads the payload EXACTLY as the queue stored it — a job may have been
 * enqueued before this story existed and sat through a deploy, which is the
 * queue's whole purpose. Nothing here may require a field the stored shape does
 * not have.
 */
export function buildTicket(ticket: TicketPayload): Buffer {
  const parts: number[] = []
  const command = (bytes: number[]) => parts.push(...bytes)

  /**
   * Emits one line, ALREADY folded.
   *
   * Folding used to happen here, after `wrapLine` had measured the raw string
   * — and several fold rules EXPAND (`…`→`...`, `€`→`EUR`, `½`→`1/2`), so a
   * line measured at 48 columns could leave here at 51. The printer then wraps
   * it at its own width, flush left with no indent, and the overflow reads as a
   * separate item under a seat heading. Everything below folds first, then
   * measures; this is the last line of defence, not the fold.
   */
  const emit = (folded: string) => {
    parts.push(...Buffer.from(foldToAscii(folded), 'ascii'))
    parts.push(0x0a)
  }

  command(INIT)

  // ── Header: the two things read from across a kitchen ─────────────────────
  //
  // Centred by the PRINTER (`ESC a 1`), not by padding the string. Doing both
  // centred it twice and pushed every header right of centre; letting the
  // printer do it is also the only version that is correct on a 58mm roll.
  command(ALIGN_CENTRE)
  command(SIZE_DOUBLE)
  command(BOLD_ON)
  // The order number beside the station, at the same size (Teran,
  // 2026-11-02): "KOT #042" is what a cook calls across the pass.
  const number = orderNumberOf(ticket)
  emit(number ? `${ticketTypeOf(ticket.destination)} ${dailyOrderLabel(number)}` : ticketTypeOf(ticket.destination))
  command(SIZE_NORMAL)

  // FR18: EVERY table on the session, or COUNTER where it has none. This line
  // used to be sliced at the paper width, so a five-table merge printed
  // "Table 10 + Table 11 + Table 12 + Table 13 + Tabl" and the runner could not
  // tell whose food it was. It is the one line that must not lose characters,
  // so it wraps like everything else.
  const tables = Array.isArray(ticket.tableLabels) ? ticket.tableLabels : []
  for (const line of wrapLine(foldToAscii(tables.join(' + ')) || 'COUNTER')) emit(line.trim())
  command(BOLD_OFF)
  command(ALIGN_LEFT)

  // The date as well as the time (Teran, 2026-11-02): a ticket found the
  // next morning, or quoted in a dispute, says which day it was.
  emit(
    `Round ${ticket.roundNumber}    ${calendarDate(ticket.submittedAt, ticket.timeZone)}  ${clockTime(ticket.submittedAt, ticket.timeZone)}`,
  )
  // The round's other stations, by name only (Teran, 2026-11-02): one line
  // tells the kitchen the pizza and the drinks are coming for the same table,
  // without spending paper on their items.
  const serveWith = serveWithLine(ticket)
  if (serveWith) {
    command(BOLD_ON)
    for (const wrapped of wrapLine(serveWith)) emit(wrapped)
    command(BOLD_OFF)
  }
  emit('-'.repeat(PAPER_COLUMNS))

  // ── Body ──────────────────────────────────────────────────────────────────
  const item = (line: TicketLine, indent: number) => {
    // Quantity and name stay together on the first line (AC-9); a long name
    // wraps under the name, not under the quantity.
    const name = printableName(line.name)
    for (const wrapped of wrapLine(`${line.quantity} x ${name}`, indent)) emit(wrapped)
    // The chosen options, one per line, before the waiter's note (Story 4.8).
    // Folded FIRST, then wrapped: wrapping measures the bytes that print. A
    // queued job from before 4.8 has no `options` at all.
    for (const option of Array.isArray(line.options) ? line.options : []) {
      const text = foldToAscii(option) || '(option)'
      for (const wrapped of wrapLine(`- ${text}`, indent + 3)) emit(wrapped)
    }
    const modifier = foldToAscii(line.modifierText)
    if (modifier !== '') {
      for (const wrapped of wrapLine(`- ${modifier}`, indent + 3)) emit(wrapped)
    }
  }

  const lines = Array.isArray(ticket.lines) ? ticket.lines : []
  if (ticket.usesSeats) {
    for (const [seat, seatLines] of groupBySeat(lines)) {
      command(BOLD_ON)
      for (const wrapped of wrapLine(foldToAscii(seat))) emit(wrapped)
      command(BOLD_OFF)
      for (const line of seatLines) item(line, 2)
    }
  } else {
    for (const line of lines) item(line, 0)
  }

  // The number that is unique for ever, at the foot where it does not compete
  // with the food: what the dashboard and a dispute look an order up by.
  const businessDate = typeof ticket.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ticket.businessDate)
    ? ticket.businessDate
    : null
  if (number && businessDate) {
    emit('-'.repeat(PAPER_COLUMNS))
    emit(`Order ${orderReference(businessDate, number)}`)
  }

  // Feed the text clear of the blade, THEN cut. `GS V 66` alone only feeds
  // fractions of a millimetre — see its comment.
  command(feedLines(4))
  command(CUT)
  return Buffer.from(parts)
}

// ── The guest's bill (Story 6.6, FR69) ───────────────────────────────────────

/**
 * Money as the paper shows it: `LKR 2,450`, `-LKR 500`.
 *
 * Signed here, not by `lkrFromPaisa`: that one loses the sign whenever the
 * rupee part is zero (`-50` paisa reads `LKR 0.50`), and a bill is the one
 * place a lost minus turns a discount into a charge.
 */
export function receiptMoney(paisa: number): string {
  const amount = Number.isFinite(paisa) ? Math.trunc(paisa) : 0
  return `${amount < 0 ? '-' : ''}${lkrFromPaisa(Math.abs(amount))}`
}

/**
 * A left text and a right-aligned amount on one 48-column line.
 *
 * The left text wraps in the space the amount leaves, continuing under
 * `indent + 2`; the amount sits on the FIRST line, beside the start of the
 * name, where an eye running down the right-hand column expects it. Folded
 * before it is measured, for the reason `emit` gives in `buildTicket`.
 */
export function amountLines(left: string, right: string, indent = 0, columns = PAPER_COLUMNS): string[] {
  const amount = foldToAscii(right)
  const room = Math.max(8, columns - amount.length - 1)
  const words = foldToAscii(left).split(/\s+/).filter(Boolean)
  const first: string[] = []
  // Fill the first line up to `room`, then wrap what is left across the full width.
  while (words.length > 0 && [...first, words[0]].join(' ').length + indent <= room) first.push(words.shift()!)
  if (first.length === 0 && words.length > 0) {
    // One word longer than the room: break it, as `wrapLine` would.
    const word = words.shift()!
    first.push(word.slice(0, room - indent))
    words.unshift(word.slice(room - indent))
  }
  const head = `${' '.repeat(indent)}${first.join(' ')}`
  const rest = words.length > 0 ? wrapLine(words.join(' '), indent + 2, columns) : []
  return [`${head.padEnd(columns - amount.length)}${amount}`, ...rest]
}

const TENDER_NAMES: Record<string, string> = { cash: 'Cash', card: 'Card', transfer: 'Transfer' }

/**
 * A bill or receipt, as the bytes a printer will accept.
 *
 * Same discipline as `buildTicket`: reads the stored payload defensively (it
 * is jsonb and may outlive this code), folds every string to ASCII, wraps at
 * the paper width, and ends with the same feed-and-cut.
 */
export function buildReceipt(receipt: ReceiptPayload): Buffer {
  const parts: number[] = []
  const command = (bytes: number[]) => parts.push(...bytes)
  const emit = (text: string) => {
    parts.push(...Buffer.from(foldToAscii(text), 'ascii'))
    parts.push(0x0a)
  }
  const divider = () => emit('-'.repeat(PAPER_COLUMNS))
  const centred = (text: unknown) => {
    const folded = foldToAscii(text)
    if (folded.trim() === '') return
    for (const line of wrapLine(folded)) emit(line.trim())
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const money = (value: unknown) => receiptMoney(typeof value === 'number' ? value : 0)
  const row = (left: string, amount: unknown) => {
    for (const line of amountLines(left, money(amount))) emit(line)
  }

  command(INIT)

  // ── Who, and what this paper is ───────────────────────────────────────────
  command(ALIGN_CENTRE)
  const logo = receipt.logo ? rasterImage(receipt.logo) : null
  if (logo) command(logo)
  // The restaurant's name is the largest thing on the guest's paper (Teran,
  // 2026-11-12). Double width halves the line, so it wraps at 24 columns.
  command(SIZE_DOUBLE)
  command(BOLD_ON)
  for (const line of wrapLine(foldToAscii(receipt.restaurantName || 'Bill'), 0, PAPER_COLUMNS / 2)) {
    emit(line.trim())
  }
  command(SIZE_NORMAL)
  command(BOLD_OFF)
  // Address and the like, in the normal size under the name.
  for (const line of strings(receipt.headerLines)) centred(line)

  // BILL or RECEIPT, without the day's `#042` beside it (Teran, 2026-11-12):
  // that number is the kitchen's. The permanent `Order 20261102-042` at the
  // foot still identifies the order.
  command(BOLD_ON)
  const number =
    Number.isInteger(receipt.dailyNumber) && receipt.dailyNumber > 0 ? receipt.dailyNumber : null
  // RECEIPT once paid; an unpaid bill prints no title at all (Teran,
  // 2026-11-12) — the guest knows what they asked for.
  const title = receipt.title === 'RECEIPT' ? 'RECEIPT' : 'BILL'
  if (title === 'RECEIPT') emit(title)
  if (receipt.copy === true) emit('COPY')
  centred(strings(receipt.tableLabels).join(' + ') || 'COUNTER')
  command(BOLD_OFF)
  if (typeof receipt.billLabel === 'string') centred(receipt.billLabel)
  command(ALIGN_LEFT)
  emit(`${calendarDate(receipt.printedAt, receipt.timeZone)}  ${clockTime(receipt.printedAt, receipt.timeZone)}`)
  const cashier = typeof receipt.cashierName === 'string' ? foldToAscii(receipt.cashierName).trim() : ''
  if (cashier !== '') emit(`Cashier: ${cashier}`)
  divider()

  // ── What was had ──────────────────────────────────────────────────────────
  for (const line of Array.isArray(receipt.lines) ? receipt.lines : []) {
    row(`${line.quantity} x ${printableName(line.name)}`, line.amountPaisa)
    for (const extra of [line.optionText, line.modifierText]) {
      const text = foldToAscii(extra)
      if (text !== '') for (const wrapped of wrapLine(`- ${text}`, 3)) emit(wrapped)
    }
  }
  for (const comp of Array.isArray(receipt.comps) ? receipt.comps : []) {
    row(`Comp: ${foldToAscii(comp.reason) || 'comp'}`, comp.amountPaisa)
  }
  divider()

  // ── The money ─────────────────────────────────────────────────────────────
  row('Subtotal', receipt.subtotalPaisa)
  if (receipt.serviceChargeBp > 0) row(`Service ${percentFromBp(receipt.serviceChargeBp)}%`, receipt.serviceChargePaisa)
  if (receipt.taxBp > 0) row(`Tax ${percentFromBp(receipt.taxBp)}%`, receipt.taxPaisa)
  command(SIZE_TALL)
  command(BOLD_ON)
  row('Total', receipt.totalPaisa)
  command(BOLD_OFF)
  command(SIZE_NORMAL)

  // ── How it was paid ───────────────────────────────────────────────────────
  const tenders = Array.isArray(receipt.tenders) ? receipt.tenders : []
  if (tenders.length > 0) {
    divider()
    for (const tender of tenders) {
      row(TENDER_NAMES[tender.method] ?? 'Paid', tender.amountPaisa)
      // Only a cash tender with the note recorded: a payment from before
      // Story 6.6 has none, and printing "Change LKR 0" would be invented.
      const received = tender.cashReceivedPaisa
      if (tender.method === 'cash' && typeof received === 'number' && received >= tender.amountPaisa) {
        row('Received', received)
        row('Change', received - tender.amountPaisa)
      }
    }
    if (title === 'BILL') {
      const paid = tenders.reduce((total, tender) => total + (tender.amountPaisa || 0), 0)
      row('Paid', paid)
      row('Still to pay', receipt.totalPaisa - paid)
    }
  }

  // ── Foot ──────────────────────────────────────────────────────────────────
  const footer = strings(receipt.footerLines)
  if (footer.length > 0) {
    divider()
    command(ALIGN_CENTRE)
    for (const line of footer) centred(line)
    command(ALIGN_LEFT)
  }
  const qr = receipt.qr
  if (qr && typeof qr.url === 'string' && /^[\x21-\x7e]{1,300}$/.test(qr.url)) {
    emit('')
    command(ALIGN_CENTRE)
    command(qrCode(qr.url))
    if (typeof qr.caption === 'string') centred(qr.caption)
    command(ALIGN_LEFT)
  }
  const businessDate =
    typeof receipt.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(receipt.businessDate)
      ? receipt.businessDate
      : null
  if (number && businessDate) {
    divider()
    emit(`Order ${orderReference(businessDate, number)}`)
  }

  command(feedLines(4))
  command(CUT)
  return Buffer.from(parts)
}

const NO_SALE_REASONS: Record<string, string> = { change: 'Change', float: 'Float', other: 'Other' }

/**
 * The end-of-day slip (Story 9.5), the owner's paper. Defensive like
 * `buildReceipt`: a missing or wrong-typed field prints as zero or nothing,
 * never throws (the job is jsonb and may outlive this code).
 */
export function buildTakings(payload: TakingsPayload): Buffer {
  const parts: number[] = []
  const command = (bytes: number[]) => parts.push(...bytes)
  const emit = (text: string) => {
    parts.push(...Buffer.from(foldToAscii(text), 'ascii'))
    parts.push(0x0a)
  }
  const divider = () => emit('-'.repeat(PAPER_COLUMNS))
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const row = (left: string, amount: unknown) => {
    for (const line of amountLines(left, receiptMoney(num(amount)))) emit(line)
  }
  const count = (left: string, value: unknown) => {
    for (const line of amountLines(left, String(num(value)))) emit(line)
  }
  const t = (payload.takings ?? {}) as Partial<TakingsPayload['takings']>
  const paid = (t.paid ?? {}) as Partial<TakingsPayload['takings']['paid']>
  const date = typeof t.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.businessDate) ? t.businessDate : ''

  command(INIT)
  command(ALIGN_CENTRE)
  command(BOLD_ON)
  for (const line of wrapLine(foldToAscii(payload.restaurantName) || 'End of day')) emit(line.trim())
  emit('END OF DAY')
  command(BOLD_OFF)
  if (date) emit(`Business day ${date}`)
  command(ALIGN_LEFT)
  if (typeof payload.printedAt === 'string') {
    emit(`Printed ${calendarDate(payload.printedAt, payload.timeZone)}  ${clockTime(payload.printedAt, payload.timeZone)}`)
  }
  const by = foldToAscii(payload.printedBy).trim()
  if (by !== '') emit(`By: ${by}`)
  divider()

  count('Orders', t.orders)
  row('Items', t.itemsPaisa)
  if (num(t.compsPaisa) !== 0) row('Comps', t.compsPaisa)
  row('Subtotal', t.subtotalPaisa)
  row('Service charge', t.serviceChargePaisa)
  row('Tax', t.taxPaisa)
  command(BOLD_ON)
  row('Total billed', t.billedPaisa)
  command(BOLD_OFF)
  divider()

  row('Cash', paid.cashPaisa)
  row('Card', paid.cardPaisa)
  if (num(paid.transferPaisa) !== 0) row('Transfer', paid.transferPaisa)
  command(SIZE_TALL)
  command(BOLD_ON)
  row('Total paid', paid.totalPaisa)
  command(BOLD_OFF)
  command(SIZE_NORMAL)

  const drawer = t.cashCount
  if (drawer && typeof drawer.countedPaisa === 'number') {
    row('Cash counted', drawer.countedPaisa)
    if (num(drawer.gapPaisa) === 0) emit('Cash balanced')
    else row(num(drawer.gapPaisa) > 0 ? 'Cash over' : 'Cash short', drawer.gapPaisa)
  }

  const unpaid = (t.closedUnpaid ?? {}) as Partial<TakingsPayload['takings']['closedUnpaid']>
  if (num(unpaid.count) > 0) {
    divider()
    row(`Closed unpaid (${num(unpaid.count)})`, unpaid.owedPaisa)
  }

  const open = Array.isArray(t.openOrders) ? t.openOrders : []
  divider()
  emit(`Still open: ${open.length}`)
  for (const order of open) {
    const number = Number.isInteger(order?.dailyNumber) ? dailyOrderLabel(order.dailyNumber) : '#?'
    const where = Array.isArray(order?.tables) ? order.tables.map((label) => foldToAscii(label)).join(' + ') : ''
    for (const line of wrapLine(`${number}  ${where}`, 2)) emit(line)
  }

  const noSales = Array.isArray(t.noSales) ? t.noSales : []
  divider()
  emit(`No-sale drawer openings: ${noSales.length}`)
  for (const opening of noSales) {
    const time = typeof opening?.openedAt === 'string' ? clockTime(opening.openedAt, payload.timeZone) : ''
    const why = opening?.reason === 'other' ? foldToAscii(opening.note) || 'Other' : NO_SALE_REASONS[opening?.reason] ?? ''
    for (const line of wrapLine(`${time}  ${foldToAscii(opening?.staffName)}  ${why}`, 2)) emit(line)
  }

  command(feedLines(4))
  command(CUT)
  return Buffer.from(parts)
}

/**
 * The bytes for any queued job: a receipt, or — every job with no `kind`,
 * including all those written before Story 6.6 — a kitchen ticket.
 */
export function buildPrintBytes(payload: PrintPayload): Buffer {
  if (isDrawerKickPayload(payload)) return buildDrawerKick()
  if (isTakingsPayload(payload)) return buildTakings(payload)
  return isReceiptPayload(payload) ? buildReceipt(payload) : buildTicket(payload)
}

/**
 * Open the cash drawer (Story 6.7): `ESC @`, then `ESC p m t1 t2` — a pulse
 * on pin `m` for t1 x 2 ms, then t2 x 2 ms off. 25/250 is 50 ms on, 500 ms
 * off, which every common solenoid drawer accepts. No paper moves.
 *
 * The pin is the cable's: most drawers answer on pin 2 (`m = 0`), some on
 * pin 5. `CASH_DRAWER_PIN=5` selects it, read now — at delivery — like the
 * printer's own settings.
 */
export function buildDrawerKick(pin: string | undefined = process.env.CASH_DRAWER_PIN): Buffer {
  const m = pin?.trim() === '5' ? 1 : 0
  return Buffer.from([...INIT, ESC, 0x70, m, 25, 250])
}
