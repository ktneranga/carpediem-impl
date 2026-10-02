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
/** `GS V 66 n` — partial cut, feeding n lines first so the cut clears the text. */
const CUT = [GS, 0x56, 66, 0x03]

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
}

export function foldToAscii(text: string): string {
  const mapped = [...text].map((character) => FOLD[character] ?? character).join('')
  // NFKD splits an accented letter into its base plus a combining mark, and the
  // range below is those marks: "é" becomes "e" rather than being dropped.
  return mapped
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
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
    const header = line.seatNote ? `${line.seatLabel} (${line.seatNote})` : line.seatLabel
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
 * "2:34 PM" (AC-2), formatted by hand.
 *
 * NOT `toLocaleTimeString`: its output depends on the host's ICU build and
 * locale, so the same ticket could print "2:34 PM" on one machine and "14:34"
 * on another, and a verification asserting either would be asserting the
 * server's configuration.
 *
 * Local time of the machine running the POS, which is the restaurant's — the
 * kitchen reads this against the clock on the wall.
 */
export function clockTime(iso: string): string {
  const when = new Date(iso)
  const hours = when.getHours()
  const minutes = when.getMinutes().toString().padStart(2, '0')
  const suffix = hours < 12 ? 'AM' : 'PM'
  const twelve = hours % 12 === 0 ? 12 : hours % 12
  return `${twelve}:${minutes} ${suffix}`
}

function centre(text: string, columns = PAPER_COLUMNS): string {
  const trimmed = text.slice(0, columns)
  const left = Math.max(0, Math.floor((columns - trimmed.length) / 2))
  return ' '.repeat(left) + trimmed
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
  const text = (value: string) => {
    parts.push(...Buffer.from(foldToAscii(value), 'ascii'))
    parts.push(0x0a)
  }
  const command = (bytes: number[]) => parts.push(...bytes)

  command(INIT)

  // ── Header: the two things read from across a kitchen ─────────────────────
  command(ALIGN_CENTRE)
  command(SIZE_DOUBLE)
  command(BOLD_ON)
  // Double-width halves the usable columns, so centre against 24, not 48.
  text(centre(ticketTypeOf(ticket.destination), Math.floor(PAPER_COLUMNS / 2)))
  command(SIZE_NORMAL)
  // FR18: every table on the session, or COUNTER where it has none. Already
  // decided at enqueue; this only prints it.
  text(centre(ticket.tableLabels.join(' + ')))
  command(BOLD_OFF)
  command(ALIGN_LEFT)

  text(`Round ${ticket.roundNumber}${' '.repeat(4)}${clockTime(ticket.submittedAt)}`)
  text('-'.repeat(PAPER_COLUMNS))

  // ── Body ──────────────────────────────────────────────────────────────────
  const item = (line: TicketLine, indent: number) => {
    // Quantity and name stay together on the first line (AC-9); a long name
    // wraps under the name, not under the quantity.
    for (const wrapped of wrapLine(`${line.quantity} x ${line.name}`, indent)) text(wrapped)
    if (line.modifierText) {
      for (const wrapped of wrapLine(`- ${line.modifierText}`, indent + 3)) text(wrapped)
    }
  }

  if (ticket.usesSeats) {
    for (const [seat, seatLines] of groupBySeat(ticket.lines)) {
      command(BOLD_ON)
      text(seat)
      command(BOLD_OFF)
      for (const line of seatLines) item(line, 2)
    }
  } else {
    for (const line of ticket.lines) item(line, 0)
  }

  command(CUT)
  return Buffer.from(parts)
}
