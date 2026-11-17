import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/server/db'
import { lkrFromPaisa } from '@/lib/format'
import { dailyOrderLabel } from '@/lib/order-number'

/**
 * Manage → Audit (Story 7.6, Teran 2026-11-17): who did what and when, from the
 * records the system already keeps. Read-only — nothing here writes.
 *
 * ── One entry per thing that happened ───────────────────────────────────────
 * Each source table is read on its own (rounds, order events, bills,
 * payments, cash drawer, config changes, printed bills) and turned into plain
 * lines, then merged and sorted. A round is ONE line ("Sent Round 2 · 4
 * items"), not one per dish; the order story lists the dishes under it.
 *
 * ── Which day ───────────────────────────────────────────────────────────────
 * `business_date_at()` on each record's own time — the day the restaurant
 * counts it on, the rule the dashboard and the order numbers use.
 */

export const AUDIT_KINDS = [
  'orders',
  'corrections',
  'cancels',
  'tables',
  'money',
  'discounts',
  'drawer',
  'settings',
  'staff',
] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]

export const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  orders: 'Orders',
  corrections: 'Corrections',
  cancels: 'Cancels & walkouts',
  tables: 'Tables',
  money: 'Money',
  discounts: 'Discounts',
  drawer: 'Cash drawer',
  settings: 'Menu & settings',
  staff: 'Staff',
}

export type AuditEntry = {
  /** Stable within a response, for React keys. */
  id: string
  /** ISO. */
  at: string
  staffName: string
  kind: AuditKind
  text: string
  /** Under the text: the dishes of a round, an approver. */
  detail: string | null
  sessionId: string | null
  /** "#042". */
  orderLabel: string | null
  /** "Table 3", "S1", "Bar tab". */
  place: string | null
  /** The order's waiter: the one picked on it, else who opened it. */
  waiter?: string | null
  /** Signed paisa when money moved: a payment +, a void −. */
  amountPaisa: number | null
  /** Story only: a printed bill. Never in the log. */
  storyOnly?: true
}

export type AuditFilters = {
  tenantId: string
  from: string
  to: string
  staffId?: string | null
  kinds?: AuditKind[] | null
  /** An order number ("42", "#042") or a table label. */
  search?: string | null
}

export type AuditCounts = { voids: number; cancels: number; drawerNoSale: number; discountsPaisa: number }

type Row = Record<string, unknown>
const rows = async (query: SQL) => (await db.execute(query)).rows as Row[]
const str = (value: unknown) => (value === null || value === undefined ? null : String(value))
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))
const iso = (value: unknown) => new Date(value as string).toISOString()

/** The order's number and place, joined onto every order-bound source. */
const ORDER_COLUMNS = sql`s.daily_number as daily_number,
  coalesce((select t.label from tables t where t.id = s.table_id), case when s.kind = 'counter' then 'Bar tab' else null end) as place,
  (select w.name from staff w where w.id = coalesce(s.served_by_staff_id, s.opened_by_staff_id)) as waiter`

/** Rows for a date range, or for one order (`sessionId`), never both. */
type Scope = { tenantId: string; from?: string; to?: string; sessionId?: string }

function within(column: SQL, scope: Scope, sessionColumn: SQL) {
  if (scope.sessionId) return sql`${sessionColumn} = ${scope.sessionId}`
  return sql`business_date_at(${scope.tenantId}, ${column}) between ${scope.from}::date and ${scope.to}::date`
}

async function loadEntries(scope: Scope): Promise<AuditEntry[]> {
  const t = scope.tenantId
  const [rounds, roundItems, events, cancelledBills, discounted, payments, drawer, configs, printed] = await Promise.all([
    rows(sql`
      select r.id, r.submitted_at as at, st.name as staff, r.session_id, r.round_number, r.item_count, ${ORDER_COLUMNS}
        from order_rounds r join order_sessions s on s.id = r.session_id join staff st on st.id = r.staff_id
       where s.tenant_id = ${t} and ${within(sql`r.submitted_at`, scope, sql`r.session_id`)}`),
    // The dishes of each round, for the line under it.
    rows(sql`
      select e.session_id, e.round_number, e.quantity, coalesce(e.custom_name, m.name, 'Item') as name, e.created_at as at
        from order_events e join order_sessions s on s.id = e.session_id left join menu_items m on m.id = e.menu_item_id
       where s.tenant_id = ${t} and e.event_type = 'ITEM_ADDED' and ${within(sql`e.created_at`, scope, sql`e.session_id`)}
       order by e.created_at`),
    rows(sql`
      select e.id, e.event_type, e.notes, e.quantity, e.unit_price_paisa, e.created_at as at, e.session_id,
             st.name as staff, ap.name as approver, coalesce(e.custom_name, m.name) as item, ${ORDER_COLUMNS},
             (select t.label from order_session_tables ot join tables t on t.id = ot.table_id
               where ot.session_id = s.id order by ot.attached_at limit 1) as first_place
        from order_events e join order_sessions s on s.id = e.session_id join staff st on st.id = e.staff_id
        left join staff ap on ap.id = e.approved_by_staff_id left join menu_items m on m.id = e.menu_item_id
       where s.tenant_id = ${t}
         and e.event_type in ('SESSION_OPENED', 'SESSION_CLOSED', 'ITEM_VOIDED', 'TABLE_MERGED', 'TABLE_UNMERGED', 'PRICING_CHANGED')
         and ${within(sql`e.created_at`, scope, sql`e.session_id`)}`),
    rows(sql`
      select b.id, b.cancelled_at as at, b.total_paisa, b.cancel_reason, b.session_id, st.name as staff, ap.name as approver, ${ORDER_COLUMNS}
        from bills b join order_sessions s on s.id = b.session_id
        join staff st on st.id = b.cancelled_by_staff_id join staff ap on ap.id = b.cancel_approved_by_staff_id
       where b.tenant_id = ${t} and b.cancelled_at is not null and ${within(sql`b.cancelled_at`, scope, sql`b.session_id`)}`),
    rows(sql`
      select b.id, b.created_at as at, b.discount_bp, b.discount_paisa, b.service_charge_waived, b.service_waived_paisa,
             b.session_id, st.name as staff, ${ORDER_COLUMNS}
        from bills b join order_sessions s on s.id = b.session_id join staff st on st.id = b.staff_id
       where b.tenant_id = ${t} and b.cancelled_at is null and (b.discount_paisa > 0 or b.service_charge_waived)
         and ${within(sql`b.created_at`, scope, sql`b.session_id`)}`),
    rows(sql`
      select p.id, p.created_at as at, p.method, p.amount_paisa, p.cash_received_paisa, p.session_id, st.name as staff, ${ORDER_COLUMNS}
        from payment_records p join order_sessions s on s.id = p.session_id join staff st on st.id = p.staff_id
       where s.tenant_id = ${t} and ${within(sql`p.created_at`, scope, sql`p.session_id`)}`),
    scope.sessionId
      ? Promise.resolve([] as Row[])
      : rows(sql`
          select o.id, o.created_at as at, o.reason, o.note, o.amount_paisa, st.name as staff
            from cash_drawer_openings o join staff st on st.id = o.staff_id
           where o.tenant_id = ${t} and o.kind = 'no_sale' and ${within(sql`o.created_at`, scope, sql`null`)}`),
    scope.sessionId
      ? Promise.resolve([] as Row[])
      : rows(sql`
          select c.id, c.created_at as at, c.table_name, c.version, c.payload,
                 lag(c.payload) over (partition by c.table_name, c.row_id order by c.version) as previous,
                 st.name as staff
            from config_changes c left join staff st on st.id = c.staff_id
           where c.tenant_id = ${t}
             and business_date_at(${t}, c.created_at) between ${scope.from}::date and ${scope.to}::date`),
    // A printed BILL, for the order story only.
    scope.sessionId
      ? rows(sql`
          select j.id, j.created_at as at, (j.ticket->>'totalPaisa')::int as total, j.ticket->>'cashierName' as staff
            from print_jobs j
           where j.session_id = ${scope.sessionId} and j.ticket->>'kind' = 'receipt' and j.ticket->>'title' = 'BILL'`)
      : Promise.resolve([] as Row[]),
  ])

  const order = (row: Row) => ({
    sessionId: str(row.session_id),
    orderLabel: row.daily_number != null ? dailyOrderLabel(Number(row.daily_number)) : null,
    place: str(row.place),
    waiter: str(row.waiter),
  })
  const out: AuditEntry[] = []

  for (const row of rounds) {
    const dishes = roundItems
      .filter((item) => item.session_id === row.session_id && Number(item.round_number) === Number(row.round_number))
      .map((item) => `${item.quantity}× ${item.name}`)
    const n = Number(row.item_count)
    out.push({
      id: `r:${row.id}`,
      at: iso(row.at),
      staffName: String(row.staff),
      kind: 'orders',
      text: `Sent Round ${row.round_number} · ${n} item${n === 1 ? '' : 's'}`,
      detail: dishes.length ? dishes.join(', ') : null,
      amountPaisa: null,
      ...order(row),
    })
  }

  for (const row of events) {
    const type = String(row.event_type)
    const notes = str(row.notes) ?? ''
    const base = { id: `e:${row.id}`, at: iso(row.at), staffName: String(row.staff), detail: null, amountPaisa: null, ...order(row) }
    if (type === 'SESSION_OPENED') {
      // Where it STARTED: a moved order's place now is not where it opened.
      out.push({ ...base, kind: 'orders', text: `Opened ${str(row.first_place) ?? (base.place === 'Bar tab' ? 'a bar tab' : base.place ?? 'an order')}` })
    } else if (type === 'SESSION_CLOSED') {
      if (notes === 'walkout') out.push({ ...base, kind: 'cancels', text: 'Closed as a walkout (unpaid)' })
      else if (notes.startsWith('cancelled')) {
        out.push({ ...base, kind: 'cancels', text: `Cancelled the order "${notes.replace(/^cancelled — /, '')}"` })
      } else if (notes === 'abandoned') out.push({ ...base, kind: 'orders', text: 'Closed with nothing ordered' })
      else out.push({ ...base, kind: 'orders', text: 'Closed (paid)' })
    } else if (type === 'ITEM_VOIDED') {
      const q = Number(row.quantity)
      const approver = str(row.approver)
      out.push({
        ...base,
        kind: 'corrections',
        text: `Voided ${q}× ${row.item ?? 'item'}${notes ? ` "${notes}"` : ''}`,
        detail: approver && approver !== base.staffName ? `approved by ${approver}` : null,
        amountPaisa: row.unit_price_paisa != null ? -q * Number(row.unit_price_paisa) : null,
      })
    } else if (type === 'TABLE_MERGED') {
      out.push({ ...base, kind: 'tables', text: notes.startsWith('Moved') || notes.startsWith('Seated') ? notes : `Merged ${notes}` })
    } else if (type === 'PRICING_CHANGED') {
      // The moment someone changed the discount or the service charge.
      out.push({ ...base, kind: 'discounts', text: notes })
    } else if (type === 'TABLE_UNMERGED' && !notes.startsWith('Moved')) {
      // A move writes both; its MERGED line already says it.
      out.push({ ...base, kind: 'tables', text: `Un-merged ${notes}` })
    }
  }

  for (const row of cancelledBills) {
    const approver = String(row.approver)
    out.push({
      id: `bc:${row.id}`,
      at: iso(row.at),
      staffName: String(row.staff),
      kind: 'corrections',
      text: `Cancelled a bill "${row.cancel_reason}"`,
      detail: approver !== row.staff ? `approved by ${approver}` : null,
      amountPaisa: -Number(row.total_paisa),
      ...order(row),
    })
  }

  for (const row of discounted) {
    const parts: string[] = []
    if (Number(row.discount_paisa) > 0) parts.push(`${Number(row.discount_bp) / 100}% discount (${lkrFromPaisa(Number(row.discount_paisa))})`)
    if (row.service_charge_waived) parts.push(`service charge waived (${lkrFromPaisa(Number(row.service_waived_paisa))})`)
    out.push({
      id: `bd:${row.id}`,
      at: iso(row.at),
      staffName: String(row.staff),
      kind: 'discounts',
      text: `On the bill: ${parts.join(', ')}`,
      detail: null,
      amountPaisa: -(Number(row.discount_paisa) + Number(row.service_waived_paisa)),
      ...order(row),
    })
  }

  for (const row of payments) {
    const method = String(row.method)
    const amount = Number(row.amount_paisa)
    const received = num(row.cash_received_paisa)
    out.push({
      id: `p:${row.id}`,
      at: iso(row.at),
      staffName: String(row.staff),
      kind: 'money',
      text: `Paid ${method === 'transfer' ? 'by bank transfer' : method === 'card' ? 'by card' : 'cash'} ${lkrFromPaisa(amount)}`,
      detail: received !== null && received > amount ? `got ${lkrFromPaisa(received)}, change ${lkrFromPaisa(received - amount)}` : null,
      amountPaisa: amount,
      ...order(row),
    })
  }

  const DRAWER: Record<string, string> = {
    float: 'Float',
    pay_in: 'Cash put in',
    paid_out: 'Paid out',
    cash_drop: 'Cash drop',
    change: 'Opened the drawer for change',
    other: 'Opened the drawer',
  }
  for (const row of drawer) {
    const amount = num(row.amount_paisa)
    const label = DRAWER[String(row.reason)] ?? 'Opened the drawer'
    out.push({
      id: `d:${row.id}`,
      at: iso(row.at),
      staffName: String(row.staff),
      kind: 'drawer',
      text: amount !== null ? `${label} ${amount > 0 ? '+' : '−'} ${lkrFromPaisa(Math.abs(amount))}` : label,
      detail: str(row.note),
      amountPaisa: amount,
      sessionId: null,
      orderLabel: null,
      place: null,
    })
  }

  for (const row of configs) out.push(configEntry(row))

  for (const row of printed) {
    out.push({
      id: `pr:${row.id}`,
      at: iso(row.at),
      staffName: str(row.staff) ?? '—',
      kind: 'money',
      text: `Bill printed · ${lkrFromPaisa(Number(row.total))}`,
      detail: null,
      amountPaisa: null,
      sessionId: scope.sessionId ?? null,
      orderLabel: null,
      place: null,
      storyOnly: true,
    })
  }

  return out
}

const TABLE_NOUNS: Record<string, string> = {
  menu_items: 'Menu',
  menu_categories: 'Menu category',
  zones: 'Zone',
  tables: 'Table',
  tenant_config: 'Settings',
  staff: 'Staff',
}

/** A config change in words: what it is, and what changed against its previous version. */
function configEntry(row: Row): AuditEntry {
  const table = String(row.table_name)
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const previous = row.previous as Record<string, unknown> | null
  const name = typeof payload.name === 'string' ? payload.name : typeof payload.label === 'string' ? payload.label : null
  const noun = TABLE_NOUNS[table] ?? table
  let what: string
  if (!previous) {
    what = table === 'tenant_config' ? 'saved' : 'added'
  } else if (previous.isActive === true && payload.isActive === false) {
    what = 'switched off'
  } else if (previous.isActive === false && payload.isActive === true) {
    what = 'switched on'
  } else if (typeof previous.pricePaisa === 'number' && typeof payload.pricePaisa === 'number' && previous.pricePaisa !== payload.pricePaisa) {
    what = `price ${lkrFromPaisa(previous.pricePaisa)} → ${lkrFromPaisa(payload.pricePaisa)}`
  } else {
    const ignore = new Set(['version', 'updatedAt', 'id', 'tenantId', 'logo', 'logoChanged'])
    const changed = Object.keys(payload).filter((key) => !ignore.has(key) && JSON.stringify(payload[key]) !== JSON.stringify(previous[key]))
    what = changed.length ? `changed ${changed.map(humanKey).join(', ')}` : 'saved'
  }
  return {
    id: `c:${row.id}`,
    at: iso(row.at),
    staffName: str(row.staff) ?? 'System',
    kind: table === 'staff' ? 'staff' : 'settings',
    text: `${noun}${name ? ` "${name}"` : ''}: ${what}`,
    detail: null,
    amountPaisa: null,
    sessionId: null,
    orderLabel: null,
    place: null,
  }
}

/** `serviceChargeBp` → "service charge". */
function humanKey(key: string): string {
  const words = key
    .replace(/(Bp|Paisa|Percent)$/, '')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim()
  return words === 'permissions' ? 'permissions' : words
}

/** The log for a date range, filtered, newest first, and its watch-out counts. */
export async function loadAudit(filters: AuditFilters): Promise<{ entries: AuditEntry[]; counts: AuditCounts; truncated: boolean }> {
  const all = (await loadEntries({ tenantId: filters.tenantId, from: filters.from, to: filters.to })).filter((entry) => !entry.storyOnly)

  // The counts are for the whole range, before the other filters.
  const counts: AuditCounts = {
    voids: all.filter((entry) => entry.kind === 'corrections' && entry.text.startsWith('Voided')).length,
    cancels: all.filter((entry) => entry.kind === 'cancels').length + all.filter((entry) => entry.text.startsWith('Cancelled a bill')).length,
    drawerNoSale: all.filter((entry) => entry.kind === 'drawer').length,
    discountsPaisa: all.filter((entry) => entry.kind === 'discounts').reduce((sum, entry) => sum + Math.abs(entry.amountPaisa ?? 0), 0),
  }

  let entries = all
  if (filters.staffId) {
    const [person] = await rows(sql`select name from staff where id = ${filters.staffId} and tenant_id = ${filters.tenantId}`)
    entries = entries.filter((entry) => entry.staffName === person?.name)
  }
  if (filters.kinds && filters.kinds.length > 0) {
    const kinds = new Set(filters.kinds)
    entries = entries.filter((entry) => kinds.has(entry.kind))
  }
  const search = filters.search?.trim().toLowerCase().replace(/^#/, '')
  if (search) {
    entries = entries.filter(
      (entry) =>
        (entry.orderLabel !== null && Number(entry.orderLabel.slice(1)) === Number(search)) ||
        (entry.place !== null && entry.place.toLowerCase().includes(search)),
    )
  }
  entries.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
  const LIMIT = 1000
  return { entries: entries.slice(0, LIMIT), counts, truncated: entries.length > LIMIT }
}

/** One order's whole story, oldest first — open or closed. */
export async function loadOrderStory(tenantId: string, sessionId: string): Promise<{ title: string; waiter: string | null; entries: AuditEntry[] } | null> {
  const [session] = await rows(sql`
    select s.daily_number, ${ORDER_COLUMNS} from order_sessions s where s.id = ${sessionId} and s.tenant_id = ${tenantId}`)
  if (!session) return null
  const entries = await loadEntries({ tenantId, sessionId })
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const title = `Order ${dailyOrderLabel(Number(session.daily_number))}${session.place ? ` · ${session.place}` : ''}`
  return { title, waiter: str(session.waiter), entries }
}
