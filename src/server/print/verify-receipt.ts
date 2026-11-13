/**
 * Story 6.6 — the guest's bill, from paper layout to the queue.
 *
 *   pnpm exec tsx --env-file=.env src/server/print/verify-receipt.ts
 *
 * Part 1 is pure: the bytes `buildReceipt` produces. Part 2 goes through the
 * real routes, so THE DEV SERVER MUST BE RUNNING (`pnpm dev`) and signed in as
 * the seeded owner (PIN 5678). It opens its own orders on a table that is
 * free, prints them, and removes every row it made. Part 3 drains a receipt
 * through the worker with fake transports, so it touches only its own jobs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
import { Pool } from 'pg'
import { io as connectSocket } from 'socket.io-client'
import { buildPrintBytes, buildReceipt, buildTicket, PAPER_COLUMNS, receiptMoney } from './escpos'
import type { ReceiptPayload, TicketPayload } from '@/types/tickets'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

/** The printable lines of a job: commands stripped, split on line feeds. */
function paperLines(bytes: Buffer): string[] {
  return bytes
    .toString('latin1')
    .replace(/\x1b[@]|\x1b[aEd][\s\S]|\x1d![\s\S]|\x1dV[\s\S]{2}/g, '')
    .split('\n')
}

const receipt = (over: Partial<ReceiptPayload> = {}): ReceiptPayload => ({
  kind: 'receipt',
  destination: 'cashier',
  title: 'BILL',
  copy: false,
  restaurantName: 'Carpe Diem',
  headerLines: [],
  footerLines: [],
  tableLabels: ['Table 7'],
  billLabel: null,
  printedAt: '2026-11-02T14:12:00Z',
  timeZone: 'Asia/Colombo',
  dailyNumber: 42,
  businessDate: '2026-11-02',
  lines: [
    { quantity: 1, name: 'Butter Prawns', amountPaisa: 245000, optionText: null, modifierText: null },
    { quantity: 2, name: 'Mojito', amountPaisa: 380000, optionText: 'Extra shot ×2', modifierText: 'no ice' },
  ],
  comps: [],
  subtotalPaisa: 625000,
  serviceChargePaisa: 62500,
  serviceChargeBp: 1000,
  taxPaisa: 0,
  taxBp: 0,
  totalPaisa: 687500,
  tenders: [],
  ...over,
})

function part1() {
  console.log('\n── Part 1: the paper ──')
  const plain = paperLines(buildReceipt(receipt()))
  const text = plain.join('\n')

  check('an unpaid bill names the restaurant, with no title and no #042', text.includes('Carpe Diem') && !/^BILL$/m.test(text) && !text.includes('#042'))
  check('table, date and time', text.includes('Table 7') && text.includes('02 Nov 2026  7:42 PM'))
  check('every line fits 48 columns', plain.every((line) => line.length <= PAPER_COLUMNS),
    String(Math.max(...plain.map((line) => line.length))))
  const prawns = plain.find((line) => line.startsWith('1 x Butter Prawns')) ?? ''
  check('amount right-aligned on the item line', prawns.length === PAPER_COLUMNS && prawns.endsWith('LKR 2,450'), prawns)
  check('options and note under the item', text.includes('   - Extra shot x2') && text.includes('   - no ice'))
  check('service with its rate', /Service 10%\s+LKR 625$/m.test(text))
  check('total', /Total\s+LKR 6,875$/m.test(text))
  check('foot carries the permanent number', text.includes('Order 20261102-042'))
  check('no COPY on a first print', !text.includes('COPY'))
  check('control bytes reach only commands: no stray 0x1b in text', !plain.some((line) => line.includes('\x1b')))

  const copy = paperLines(buildReceipt(receipt({ copy: true }))).join('\n')
  check('a reprint says COPY', copy.includes('COPY'))

  const paid = paperLines(
    buildReceipt(
      receipt({
        title: 'RECEIPT',
        tenders: [{ method: 'cash', amountPaisa: 687500, cashReceivedPaisa: 700000 }],
      }),
    ),
  ).join('\n')
  check('a paid bill is a RECEIPT', /^RECEIPT$/m.test(paid))
  check('cash, received and change', /Cash\s+LKR 6,875$/m.test(paid) && /Received\s+LKR 7,000$/m.test(paid) && /Change\s+LKR 125$/m.test(paid))
  check('a receipt has no "Still to pay"', !paid.includes('Still to pay'))

  const split = paperLines(
    buildReceipt(
      receipt({
        title: 'RECEIPT',
        tenders: [
          { method: 'cash', amountPaisa: 200000, cashReceivedPaisa: 500000 },
          { method: 'card', amountPaisa: 487500, cashReceivedPaisa: null },
        ],
      }),
    ),
  ).join('\n')
  check('cash + card: both tenders, change from the cash part only',
    /Card\s+LKR 4,875$/m.test(split) && /Change\s+LKR 3,000$/m.test(split) && (split.match(/Change/g) ?? []).length === 1)

  const old = paperLines(
    buildReceipt(receipt({ title: 'RECEIPT', tenders: [{ method: 'cash', amountPaisa: 687500, cashReceivedPaisa: null }] })),
  ).join('\n')
  check('a payment from before 6.6 prints no Received or Change', !old.includes('Received') && !old.includes('Change'))

  const partPaid = paperLines(
    buildReceipt(receipt({ tenders: [{ method: 'card', amountPaisa: 300000, cashReceivedPaisa: null }] })),
  ).join('\n')
  check('a part-paid bill shows Paid and Still to pay', /Paid\s+LKR 3,000$/m.test(partPaid) && /Still to pay\s+LKR 3,875$/m.test(partPaid))

  const awkward = paperLines(
    buildReceipt(
      receipt({
        lines: [
          {
            quantity: 1,
            name: 'Slow-cooked black pork curry with tempered potatoes and pol sambol\x1b@',
            amountPaisa: 1250050,
            optionText: null,
            modifierText: null,
          },
          { quantity: 1, name: 'ලංකා බත්', amountPaisa: 100000, optionText: null, modifierText: null },
        ],
      }),
    ),
  )
  const first = awkward.find((line) => line.startsWith('1 x Slow-cooked')) ?? ''
  check('a long name wraps beside its amount, never past 48', awkward.every((line) => line.length <= PAPER_COLUMNS) && first.endsWith('LKR 12,500.50'), first)
  // Checked on the RAW bytes: `paperLines` strips command sequences, which
  // would hide an injected `ESC @` as well.
  const raw = buildReceipt(
    receipt({ lines: [{ quantity: 1, name: 'Pork curry\x1b@', amountPaisa: 100, optionText: null, modifierText: null }] }),
  ).toString('latin1')
  check('an injected escape byte never reaches paper', raw.includes('Pork curry@') && !raw.includes('curry\x1b'))
  check('a name that cannot print says so', awkward.join('\n').includes('[name not printable]'))

  check('money keeps its sign below one rupee', receiptMoney(-50) === '-LKR 0.50' && receiptMoney(-50000) === '-LKR 500', receiptMoney(-50))
  const comped = paperLines(buildReceipt(receipt({ comps: [{ reason: 'Customer complaint', amountPaisa: -50000 }] }))).join('\n')
  check('a comp prints as a deduction', /Comp: Customer complaint\s+-LKR 500$/m.test(comped))

  // Cashier and the review QR (Teran, 2026-11-12).
  const url = 'https://www.google.com/search?q=carpe+diem+hikkaduwa'
  const extras = buildReceipt(
    receipt({ cashierName: 'Nina', qr: { url, caption: 'Scan to review us on Google' }, footerLines: ['Thank you! Come again'] }),
  ).toString('latin1')
  check('the cashier is named', /^Cashier: Nina$/m.test(extras))
  const store = Buffer.from([0x1d, 0x28, 0x6b, (url.length + 3) & 0xff, (url.length + 3) >> 8, 0x31, 0x50, 0x30]).toString('latin1') + url
  check('the QR stores the link and prints it', extras.includes(store) && extras.includes('\x1d(k\x03\x001Q0'))
  check('the QR caption is under the code, after the thank-you line',
    extras.indexOf('Thank you!') < extras.indexOf(store) && extras.indexOf(store) < extras.indexOf('Scan to review us on Google'))
  const noExtras = buildReceipt(receipt()).toString('latin1')
  check('no cashier and no QR when not set', !noExtras.includes('Cashier') && !noExtras.includes('\x1d(k'))
  // The logo (Teran, 2026-11-12): a 16x2 raster, then the name under it.
  const logo = { widthDots: 16, heightDots: 2, data: Buffer.from([0xff, 0x00, 0x0f, 0xf0]).toString('base64') }
  const withLogo = buildReceipt(receipt({ logo })).toString('latin1')
  const raster = '\x1dv0\x00\x02\x00\x02\x00' + Buffer.from([0xff, 0x00, 0x0f, 0xf0]).toString('latin1')
  check('the logo prints above the name', withLogo.includes(raster) && withLogo.indexOf(raster) < withLogo.indexOf('Carpe Diem'))
  check('no logo when not set', !noExtras.includes('\x1dv0'))
  const wrongSize = buildReceipt(receipt({ logo: { ...logo, heightDots: 3 } })).toString('latin1')
  const tooWide = buildReceipt(receipt({ logo: { widthDots: 640, heightDots: 1, data: Buffer.alloc(80).toString('base64') } })).toString('latin1')
  check('a malformed or too-wide logo prints none', !wrongSize.includes('\x1dv0') && !tooWide.includes('\x1dv0'))

  const bad = buildReceipt(receipt({ qr: { url: 'https://x.com/a b\x1b', caption: null } })).toString('latin1')
  check('a link with spaces or control bytes prints no QR', !bad.includes('\x1d(k'))

  const ticket: TicketPayload = {
    destination: 'kitchen', roundNumber: 2, tableLabels: ['Table 5'], usesSeats: false,
    submittedAt: '2026-11-02T14:12:00Z', timeZone: 'Asia/Colombo', dailyNumber: 42, businessDate: '2026-11-02',
    lines: [{ eventId: 'e', quantity: 1, name: 'Fried Rice', modifierText: null, seatLabel: 'Seat 1', seatNote: null }],
  } as TicketPayload
  check('a job with no kind prints as the same ticket', buildPrintBytes(ticket).equals(buildTicket(ticket)))
  check('a receipt job prints as a receipt', buildPrintBytes(receipt()).equals(buildReceipt(receipt())))
}

// ── Part 2: through the real routes ──────────────────────────────────────────

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows
/** Every session this run opens; cleanup deletes by these and nothing else. */
const mine: string[] = []

/** The append-only guards this script switches off while it cleans up. */
const GUARDS = [
  ['payment_records', 'immutable_payment_records'],
  ['bill_lines', 'immutable_bill_lines'],
  ['bills', 'immutable_bills'],
  ['order_events', 'immutable_order_events'],
  ['order_rounds', 'immutable_order_rounds'],
  // A cash payment opens the drawer (Story 6.7) and records it.
  ['cash_drawer_openings', 'immutable_cash_drawer_openings'],
] as const

/**
 * Parts 2 and 3 DISABLE append-only triggers (under ACCESS EXCLUSIVE locks) to
 * delete their own rows. Never against a database that is not on this machine,
 * and every guard is switched back on first: a run killed mid-cleanup would
 * otherwise leave the immutability guarantees off (code review, 2026-11-11).
 */
async function prepareDatabase() {
  const url = process.env.DATABASE_URL ?? ''
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && process.env.VERIFY_ALLOW_REMOTE_DB !== '1') {
    throw new Error(
      `verify-receipt disables append-only triggers; DATABASE_URL host "${host}" is not local. Set VERIFY_ALLOW_REMOTE_DB=1 only for a throwaway database.`,
    )
  }
  for (const [table, trigger] of GUARDS) await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
}

async function login(pin: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  const setCookie = response.headers.get('set-cookie')
  if (!response.ok || !setCookie) throw new Error(`login ${pin} failed: ${response.status}`)
  return setCookie.split(';')[0]!
}

async function api(cookie: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

/** A bar tab named for the guest, with a cashew ×2 and a prawns ×1 on it. */
async function makeTab(nickname: string) {
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [waiter] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active LIMIT 1`)
  const [item] = await sql(`SELECT id FROM menu_items LIMIT 1`)
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, tab_label) VALUES ($1, 'counter', $2, $3) RETURNING id`,
    [tenant.id, waiter.id, nickname],
  )
  mine.push(session.id)
  // The seat NOTE is the other way a nickname could reach paper.
  const [seat] = await sql(
    `INSERT INTO seat_slots (session_id, seat_label, seat_note) VALUES ($1, 'Seat 1', 'red shirt') RETURNING id`,
    [session.id],
  )
  const add = async (quantity: number, price: number) =>
    (
      await sql(
        `INSERT INTO order_events (session_id, staff_id, menu_item_id, event_type, seat_slot_id, quantity, unit_price_paisa, round_number, modifier_text)
         VALUES ($1, $2, $3, 'ITEM_ADDED', $4, $5, $6, 1, 'extra spicy') RETURNING id`,
        [session.id, waiter.id, item.id, seat.id, quantity, price],
      )
    )[0].id as string
  const cashew = await add(2, 95000)
  const prawns = await add(1, 245000)
  return { sessionId: session.id as string, cashew, prawns, add }
}

async function jobOf(jobId: string) {
  const [job] = await sql(`SELECT destination::text, round_id, bill_id, status::text, ticket FROM print_jobs WHERE id = $1`, [jobId])
  return job as { destination: string; round_id: string | null; bill_id: string | null; status: string; ticket: ReceiptPayload }
}

/** The floor's view of one bar tab's payment state, through the real route. */
async function tabState(cookie: string, sessionId: string): Promise<string | undefined> {
  const response = await fetch(`${BASE}/api/sessions`, { headers: { cookie } })
  const body = (await response.json()) as any
  return body?.data?.find((row: any) => row.sessionId === sessionId)?.paymentState
}

async function part2() {
  console.log('\n── Part 2: the routes ──')
  await prepareDatabase()
  const owner = await login('5678')
  const tab = await makeTab('white shirt')

  // Listens like a tablet on the floor: every `session:payment_changed`.
  const heard: { sessionId: string; paymentState: string }[] = []
  const socket = connectSocket(BASE, { extraHeaders: { cookie: owner }, transports: ['websocket'] })
  socket.on('session:payment_changed', (payload) => heard.push(payload))
  await new Promise<void>((resolve) => {
    socket.on('connect', () => resolve())
    setTimeout(resolve, 3000)
  })
  check('setup: the floor socket connects', socket.connected)
  const heardFor = async (sessionId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return heard.filter((event) => event.sessionId === sessionId).at(-1)?.paymentState
  }
  check('an unpaid tab shows no payment state', (await tabState(owner, tab.sessionId)) === 'none')

  // ── A draft: the whole table, nothing recorded ─────────────────────────────
  const whole = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`)
  check('printing a draft queues a job (202)', whole.status === 202 && typeof whole.body?.data?.jobId === 'string', JSON.stringify(whole.body))
  const draftJob = await jobOf(whole.body.data.jobId)
  check('to the cashier, with no round and no bill',
    draftJob.destination === 'cashier' && draftJob.round_id === null && draftJob.bill_id === null)
  const [{ n: billsAfterDraft }] = await sql(`SELECT count(*)::int n FROM bills WHERE session_id = $1`, [tab.sessionId])
  check('printing writes no bill', billsAfterDraft === 0)
  check('priced by the server: 2 x 950 + 2,450, no service on a tab',
    draftJob.ticket.subtotalPaisa === 435000 && draftJob.ticket.serviceChargePaisa === 0 && draftJob.ticket.totalPaisa === 435000,
    `${draftJob.ticket.subtotalPaisa} / ${draftJob.ticket.totalPaisa}`)
  check('a tab prints as "Bar tab"', draftJob.ticket.tableLabels.join() === 'Bar tab')
  const draftText = JSON.stringify(draftJob.ticket)
  check('the nickname and the seat note are nowhere in the job',
    !draftText.includes('white shirt') && !draftText.includes('red shirt'))
  check('the kitchen note prints', draftJob.ticket.lines.every((line) => line.modifierText === 'extra spicy'))
  check('a draft is a BILL, never a COPY', draftJob.ticket.title === 'BILL' && draftJob.ticket.copy === false)

  // ── A person's share ───────────────────────────────────────────────────────
  const share = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`, {
    items: [{ eventId: tab.cashew, quantity: 1 }],
    personLabel: 'red shirt',
  })
  const shareJob = await jobOf(share.body?.data?.jobId)
  check('a share prints only its units', shareJob.ticket.lines.length === 1 && shareJob.ticket.totalPaisa === 95000,
    String(shareJob.ticket.totalPaisa))
  check('a seat note as the person\'s name prints "Split bill"', shareJob.ticket.billLabel === 'Split bill')
  const named = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`, {
    items: [{ eventId: tab.cashew, quantity: 1 }],
    personLabel: 'Person 2',
  })
  check('"Person 2" prints as itself', (await jobOf(named.body?.data?.jobId)).ticket.billLabel === 'Person 2')
  const tooMany = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`, {
    items: [{ eventId: tab.cashew, quantity: 3 }],
  })
  check('more units than are left is refused (409), no job', tooMany.status === 409, String(tooMany.status))
  const malformed = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`, { items: [{ eventId: 'x', quantity: 1 }] })
  check('a malformed share is refused (400)', malformed.status === 400)

  // ── The total on the waiter's screen (Teran, 2026-11-11) ──────────────────
  const stale = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`, {
    expectedTotalPaisa: draftJob.ticket.totalPaisa + 100,
  })
  check('a bill whose total changed since the screen loaded is refused (409), no job',
    stale.status === 409 && stale.body?.error?.code === 'BILL_CHANGED', String(stale.status))
  const fresh = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`, {
    expectedTotalPaisa: draftJob.ticket.totalPaisa,
  })
  check('the same bill with the total the screen showed prints (202)', fresh.status === 202, String(fresh.status))

  // ── A share equals what Settle then records for it (Testing case 2) ────────
  const splitTab = await makeTab('green shirt')
  const shareItems = [{ eventId: splitTab.cashew, quantity: 1 }]
  const splitShare = await jobOf((await api(owner, `/api/sessions/${splitTab.sessionId}/bill-print`, { items: shareItems, personLabel: 'Person 2' })).body?.data?.jobId)
  const splitBill = await api(owner, `/api/sessions/${splitTab.sessionId}/bills`, { type: 'split', items: shareItems, personLabel: 'Person 2' })
  check('a printed share agrees to the paisa with the split bill Settle records',
    splitBill.status === 201 &&
      splitBill.body?.data?.totalPaisa === splitShare.ticket.totalPaisa &&
      splitBill.body?.data?.subtotalPaisa === splitShare.ticket.subtotalPaisa,
    `${splitBill.body?.data?.totalPaisa} vs ${splitShare.ticket.totalPaisa}`)

  // ── A recorded bill: first print, copy, dead job ───────────────────────────
  const settle = await api(owner, `/api/sessions/${tab.sessionId}/bills`, { type: 'consolidated' })
  const billId = settle.body?.data?.billId as string
  check('setup: the bill is recorded', settle.status === 201 && typeof billId === 'string', JSON.stringify(settle.body))
  check('the printed draft and the bill Settle records agree to the paisa',
    settle.body?.data?.totalPaisa === draftJob.ticket.totalPaisa &&
      settle.body?.data?.subtotalPaisa === draftJob.ticket.subtotalPaisa,
    `${settle.body?.data?.totalPaisa} vs ${draftJob.ticket.totalPaisa}`)
  const first = await jobOf((await api(owner, `/api/bills/${billId}/print`)).body?.data?.jobId)
  check('a recorded bill names itself on the job', first.bill_id === billId && first.ticket.copy === false)
  // A COPY is the same document printed AGAIN — the first must have reached
  // paper (Teran, 2026-11-11). Still waiting in the queue, it has not.
  const second = await jobOf((await api(owner, `/api/bills/${billId}/print`)).body?.data?.jobId)
  check('printed again while the first is still waiting, it is NOT a COPY', second.ticket.copy === false)
  await sql(`UPDATE print_jobs SET status = 'printed' WHERE bill_id = $1`, [billId])
  const third = await jobOf((await api(owner, `/api/bills/${billId}/print`)).body?.data?.jobId)
  check('printed again after the first reached paper, it is a COPY', third.ticket.copy === true)
  await sql(`UPDATE print_jobs SET status = 'dead' WHERE bill_id = $1`, [billId])
  const afterDead = await jobOf((await api(owner, `/api/bills/${billId}/print`)).body?.data?.jobId)
  check('jobs that never printed do not make a COPY', afterDead.ticket.copy === false)

  // ── Paid: a RECEIPT with the change ────────────────────────────────────────
  // The drafts printed above never reached the guest here: without this, the
  // printed BILL would make the receipt skip itself (Teran, 2026-11-13), and
  // this block is about what the receipt says.
  await sql(`UPDATE print_jobs SET status = 'dead' WHERE session_id = $1 AND bill_id IS NULL`, [tab.sessionId])
  // Before paying, while the bill is still open — afterwards the refusal would
  // be "already settled" and say nothing about this rule.
  const short = await api(owner, `/api/bills/${billId}/payments`, {
    tenders: [{ method: 'cash', amountPaisa: 435000 }],
    cashReceivedPaisa: 400000,
  })
  check('cash received below the cash tender is refused (400)', short.status === 400, String(short.status))
  const cardOnly = await api(owner, `/api/bills/${billId}/payments`, {
    tenders: [{ method: 'card', amountPaisa: 435000 }],
    cashReceivedPaisa: 500000,
  })
  check('cash received with no cash tender is refused (400)', cardOnly.status === 400, String(cardOnly.status))
  const pay = await api(owner, `/api/bills/${billId}/payments`, {
    tenders: [{ method: 'cash', amountPaisa: 435000 }],
    cashReceivedPaisa: 500000,
  })
  check('setup: paid in cash, 5,000 handed over', pay.status === 201, JSON.stringify(pay.body))
  const [payment] = await sql(`SELECT amount_paisa, cash_received_paisa FROM payment_records WHERE bill_id = $1`, [billId])
  check('the cash received is kept, the amount still capped at the bill',
    payment?.amount_paisa === 435000 && payment?.cash_received_paisa === 500000, JSON.stringify(payment))
  // The receipt prints BY ITSELF with the payment that settles the bill (Teran,
  // 2026-11-10) — the payment response names the job it queued.
  const autoId = pay.body?.data?.receiptJobId as string | null
  check('settling the bill queues its receipt by itself', typeof autoId === 'string', JSON.stringify(pay.body?.data))
  const receiptJob = await jobOf(autoId!)
  check('a paid bill prints as a RECEIPT with its tender',
    receiptJob.ticket.title === 'RECEIPT' &&
      receiptJob.bill_id === billId &&
      receiptJob.ticket.tenders.length === 1 &&
      receiptJob.ticket.tenders[0]!.cashReceivedPaisa === 500000)
  check('the receipt is not a COPY of the bill printed before paying', receiptJob.ticket.copy === false)
  const receiptPaper = paperLines(buildReceipt(receiptJob.ticket)).join('\n')
  check('and the paper shows the change', /Change\s+LKR 650$/m.test(receiptPaper))
  await sql(`UPDATE print_jobs SET status = 'printed' WHERE bill_id = $1`, [billId])
  const again = await jobOf((await api(owner, `/api/bills/${billId}/print`)).body?.data?.jobId)
  check('Print receipt afterwards prints a COPY', again.ticket.title === 'RECEIPT' && again.ticket.copy === true)

  // ── No second slip when the guest already holds the bill (Teran, 2026-11-13)
  // The printed BILL is their slip, unless items changed after it printed.
  const unchanged = await makeTab('No second slip')
  await api(owner, `/api/sessions/${unchanged.sessionId}/bill-print`)
  const unchangedBill = (await api(owner, `/api/sessions/${unchanged.sessionId}/bills`, { type: 'consolidated' })).body?.data
  const unchangedPay = await api(owner, `/api/bills/${unchangedBill?.billId}/payments`, {
    tenders: [{ method: 'card', amountPaisa: unchangedBill?.totalPaisa }],
  })
  check('bill printed, nothing added, paid → no automatic receipt',
    unchangedPay.status === 201 && unchangedPay.body?.data?.receiptJobId === null && unchangedPay.body?.data?.receiptSkipped === true,
    JSON.stringify(unchangedPay.body?.data))
  const splitPay = await api(owner, `/api/bills/${splitBill.body?.data?.billId}/payments`, {
    tenders: [{ method: 'card', amountPaisa: splitBill.body?.data?.totalPaisa }],
  })
  check('a split share printed for that person, paid → no automatic receipt',
    splitPay.status === 201 && splitPay.body?.data?.receiptSkipped === true, JSON.stringify(splitPay.body?.data))
  const changed = await makeTab('Added after')
  await api(owner, `/api/sessions/${changed.sessionId}/bill-print`)
  await changed.add(1, 50000)
  const changedBill = (await api(owner, `/api/sessions/${changed.sessionId}/bills`, { type: 'consolidated' })).body?.data
  const changedPay = await api(owner, `/api/bills/${changedBill?.billId}/payments`, {
    tenders: [{ method: 'card', amountPaisa: changedBill?.totalPaisa }],
  })
  check('bill printed, then an item added, paid → the receipt prints',
    changedPay.status === 201 && typeof changedPay.body?.data?.receiptJobId === 'string' && changedPay.body?.data?.receiptSkipped === false,
    JSON.stringify(changedPay.body?.data))

  // The payment request from before this story — no cashReceivedPaisa — must
  // still be accepted, and stores no received amount. Paid in two parts: the
  // first part prints nothing, the last prints the receipt.
  const other = await makeTab('Card')
  const otherBill = (await api(owner, `/api/sessions/${other.sessionId}/bills`, { type: 'consolidated' })).body?.data?.billId
  const part = await api(owner, `/api/bills/${otherBill}/payments`, { tenders: [{ method: 'card', amountPaisa: 135000 }] })
  check('a part payment prints nothing', part.status === 201 && part.body?.data?.receiptJobId === null, JSON.stringify(part.body?.data))
  const card = await api(owner, `/api/bills/${otherBill}/payments`, { tenders: [{ method: 'card', amountPaisa: 300000 }] })
  const cardRows = await sql(`SELECT cash_received_paisa FROM payment_records WHERE bill_id = $1`, [otherBill])
  check('a payment without cashReceivedPaisa is still accepted, storing none',
    card.status === 201 && cardRows.every((row) => row.cash_received_paisa === null), `${card.status} ${JSON.stringify(cardRows)}`)
  const cardJob = await jobOf(card.body?.data?.receiptJobId)
  const cardPaper = paperLines(buildReceipt(cardJob.ticket)).join('\n')
  check('the last part prints the receipt, both card tenders, no change',
    cardJob.ticket.title === 'RECEIPT' && (cardPaper.match(/^Card\s/gm) ?? []).length === 2 && !cardPaper.includes('Change'))

  // ── The floor's ✓ Paid (Teran, 2026-11-10) ─────────────────────────────────
  check('a paid tab shows ✓ Paid in the list', (await tabState(owner, tab.sessionId)) === 'paid')
  check('and every tablet hears it live', (await heardFor(tab.sessionId)) === 'paid')
  check('a part-paid tab shows Part paid, live', (await heardFor(other.sessionId)) === 'paid' &&
    heard.some((event) => event.sessionId === other.sessionId && event.paymentState === 'part'))

  // A paid table, then one more drink: it owes again.
  const [freeTable] = await sql(
    `SELECT t.id, t.label FROM tables t
      WHERE t.status <> 'unavailable'
        AND NOT EXISTS (SELECT 1 FROM order_session_tables ost WHERE ost.table_id = t.id AND ost.released_at IS NULL)
      LIMIT 1`,
  )
  if (freeTable) {
    const seated = await makeTab('Seated')
    await sql(`UPDATE order_sessions SET kind = 'table', tab_label = NULL WHERE id = $1`, [seated.sessionId])
    await sql(`INSERT INTO order_session_tables (session_id, table_id) VALUES ($1, $2)`, [seated.sessionId, freeTable.id])
    const seatedBill = (await api(owner, `/api/sessions/${seated.sessionId}/bills`, { type: 'consolidated' })).body?.data
    await api(owner, `/api/bills/${seatedBill?.billId}/payments`, { tenders: [{ method: 'card', amountPaisa: seatedBill?.totalPaisa }] })
    const floor = async () => {
      const response = await fetch(`${BASE}/api/tables`, { headers: { cookie: owner } })
      return ((await response.json()) as any).data.find((row: any) => row.id === freeTable.id)
    }
    const paidCard = await floor()
    check('a paid table card says paid, and stays occupied', paidCard?.paymentState === 'paid' && paidCard?.status === 'occupied',
      JSON.stringify({ state: paidCard?.paymentState, status: paidCard?.status }))
    const [{ staff_id: waiterId, menu_item_id: itemId }] = await sql(
      `SELECT staff_id, menu_item_id FROM order_events WHERE session_id = $1 AND event_type = 'ITEM_ADDED' LIMIT 1`,
      [seated.sessionId],
    )
    await sql(
      `INSERT INTO order_events (session_id, staff_id, menu_item_id, event_type, quantity, unit_price_paisa, round_number)
       VALUES ($1, $2, $3, 'ITEM_ADDED', 1, 50000, 2)`,
      [seated.sessionId, waiterId, itemId],
    )
    check('one more drink and it is no longer paid', (await floor())?.paymentState === 'part')
    const refused = await api(owner, `/api/sessions/${seated.sessionId}/close`, { reason: 'settled' })
    check('Close table is refused while something is owed (409)', refused.status === 409, String(refused.status))
    await sql(`UPDATE order_session_tables SET released_at = now() WHERE session_id = $1`, [seated.sessionId])
  } else {
    console.log('SKIP the table-card checks — no free table')
  }
  socket.disconnect()

  // ── Closed ─────────────────────────────────────────────────────────────────
  const close = await api(owner, `/api/sessions/${tab.sessionId}/close`, { reason: 'settled' })
  check('setup: the tab closes', close.status === 200, JSON.stringify(close.body))
  const closed = await api(owner, `/api/bills/${billId}/print`)
  check('a closed order refuses to print (409)', closed.status === 409)
  const closedDraft = await api(owner, `/api/sessions/${tab.sessionId}/bill-print`)
  check('a closed order refuses a draft too (409)', closedDraft.status === 409)
  check('an unknown bill is 404',
    (await api(owner, `/api/bills/00000000-0000-4000-8000-000000000000/print`)).status === 404)
}

// ── Part 3: through the worker (dev server STOPPED) ──────────────────────────

async function part3() {
  console.log('\n── Part 3: the worker ──')
  await prepareDatabase()
  const { drainPrintQueue } = await import('./worker')
  const tab = await makeTab('Test')
  const [tenant] = await sql(`SELECT tenant_id FROM order_sessions WHERE id = $1`, [tab.sessionId])
  const [round] = await sql(
    `INSERT INTO order_rounds (id, session_id, round_number, staff_id, item_count)
     SELECT gen_random_uuid(), $1, 1, staff_id, 1 FROM order_events WHERE session_id = $1 LIMIT 1 RETURNING id`,
    [tab.sessionId],
  )
  const seed = async (destination: string, ticket: object, roundId: string | null) =>
    (
      await sql(
        `INSERT INTO print_jobs (tenant_id, session_id, round_id, destination, ticket)
         VALUES ($1, $2, $3, $4::print_destination, $5::jsonb) RETURNING id`,
        [tenant.tenant_id, tab.sessionId, roundId, destination, JSON.stringify(ticket)],
      )
    )[0].id as string

  // A kitchen ticket stuck in its backoff must not hold up a bill.
  const stuck = await seed('kitchen', { destination: 'kitchen', roundNumber: 1, tableLabels: ['T'], usesSeats: false, submittedAt: new Date().toISOString(), lines: [] }, round.id)
  await sql(`UPDATE print_jobs SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [stuck])
  const bill = await seed('cashier', receipt(), null)

  const delivered: string[] = []
  await drainPrintQueue((destination) => ({
    name: 'fake',
    deliver: (payload) => {
      delivered.push(`${destination}:${'kind' in payload ? payload.kind : 'ticket'}`)
      return Promise.resolve()
    },
  }))
  const [billRow] = await sql(`SELECT status::text FROM print_jobs WHERE id = $1`, [bill])
  check('a bill prints while a kitchen ticket waits out its backoff',
    billRow.status === 'printed' && delivered.includes('cashier:receipt') && !delivered.some((entry) => entry.startsWith('kitchen')),
    delivered.join())

  const failing = await seed('cashier', receipt(), null)
  const alerts: { kind: string; destination: string }[] = []
  ;(globalThis as { __io?: unknown }).__io = { emit: (_event: string, payload: { kind: string; destination: string }) => alerts.push(payload) }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await drainPrintQueue(() => ({ name: 'broken', deliver: () => Promise.reject(new Error('paper out')) }))
    await sql(`UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1`, [failing])
  }
  const [failRow] = await sql(`SELECT status::text, attempts FROM print_jobs WHERE id = $1`, [failing])
  check('a failing bill retries, then dead-letters with a cashier alert',
    failRow.status === 'dead' && alerts.some((alert) => alert.kind === 'dead' && alert.destination === 'cashier'),
    `${failRow.status} after ${failRow.attempts}`)
  await sql(`DELETE FROM print_jobs WHERE id = ANY($1::uuid[])`, [[stuck, bill, failing]])
  await sql(`ALTER TABLE order_rounds DISABLE TRIGGER immutable_order_rounds`)
  try {
    await sql(`DELETE FROM order_rounds WHERE id = $1`, [round.id])
  } finally {
    await sql(`ALTER TABLE order_rounds ENABLE TRIGGER immutable_order_rounds`)
  }
}

/** Deletes exactly what this run made, with every append-only guard back on after. */
async function cleanup() {
  if (mine.length === 0) return
  const guarded = GUARDS.filter(([table]) => table !== 'order_rounds')
  try {
    for (const [table, trigger] of guarded) await sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
    // The drawer rows first: they point at this run's payments and jobs.
    await sql(
      `DELETE FROM cash_drawer_openings WHERE print_job_id IN (SELECT id FROM print_jobs WHERE session_id = ANY($1::uuid[]))`,
      [mine],
    )
    await sql(`DELETE FROM print_jobs WHERE session_id = ANY($1::uuid[])`, [mine])
    await sql(`DELETE FROM payment_records WHERE session_id = ANY($1::uuid[])`, [mine])
    await sql(`DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE session_id = ANY($1::uuid[]))`, [mine])
    await sql(`DELETE FROM bills WHERE session_id = ANY($1::uuid[])`, [mine])
    await sql(`DELETE FROM order_events WHERE session_id = ANY($1::uuid[])`, [mine])
  } finally {
    for (const [table, trigger] of guarded) {
      await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`).catch((error) =>
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error),
      )
    }
  }
  await sql(`DELETE FROM order_session_tables WHERE session_id = ANY($1::uuid[])`, [mine])
  await sql(`DELETE FROM seat_slots WHERE session_id = ANY($1::uuid[])`, [mine])
  await sql(`DELETE FROM order_sessions WHERE id = ANY($1::uuid[])`, [mine])
}

async function main() {
  part1()
  try {
    // Part 3 needs the dev server STOPPED (its worker would claim the jobs);
    // part 2 needs it running. So they are separate runs.
    if (process.argv.includes('--worker')) await part3()
    else if (!process.argv.includes('--paper-only')) await part2()
  } finally {
    await cleanup()
    await pool.end()
  }
}

main()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(() => {
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exitCode = results.every(Boolean) ? 0 : 1
  })
