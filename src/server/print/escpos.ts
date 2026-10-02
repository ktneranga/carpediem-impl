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
import type { TicketPayload } from '@/types/tickets'
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
  emit(ticketTypeOf(ticket.destination))
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

  emit(`Round ${ticket.roundNumber}    ${clockTime(ticket.submittedAt, ticket.timeZone)}`)
  emit('-'.repeat(PAPER_COLUMNS))

  // ── Body ──────────────────────────────────────────────────────────────────
  const item = (line: TicketLine, indent: number) => {
    // Quantity and name stay together on the first line (AC-9); a long name
    // wraps under the name, not under the quantity.
    const name = printableName(line.name)
    for (const wrapped of wrapLine(`${line.quantity} x ${name}`, indent)) emit(wrapped)
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

  // Feed the text clear of the blade, THEN cut. `GS V 66` alone only feeds
  // fractions of a millimetre — see its comment.
  command(feedLines(4))
  command(CUT)
  return Buffer.from(parts)
}
