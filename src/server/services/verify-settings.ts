/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Manage → Settings (spec-restaurant-settings), through the service, on a
 * throwaway tenant; plus the logo converter on a tiny known image.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-settings.ts
 *
 * Cleanup on a local database only.
 */
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { buildReceipt } from '@/server/print/escpos'
import { StaleVersionError } from '@/server/services/menu-admin.service'
import { loadSettings, saveSettings, SettingsFieldError, type SettingsInput } from '@/server/services/settings.service'
import { logoSize, rasterToRgba, toLogoRaster } from '@/lib/logo-raster'
import type { ReceiptPayload } from '@/types/tickets'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const one = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows[0] as any
const tenantIds: string[] = []

/** An 8 × 2 image: row 0 black-white alternating, row 1 all white except a transparent-black last pixel. */
function tinyImage(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(8 * 2 * 4)
  for (let x = 0; x < 8; x += 1) {
    const v = x % 2 === 0 ? 0 : 255
    px.set([v, v, v, 255], x * 4)
    px.set([255, 255, 255, 255], (8 + x) * 4)
  }
  px.set([0, 0, 0, 0], (8 + 7) * 4) // transparent black counts as paper
  return px
}

async function run() {
  // ── The converter ──────────────────────────────────────────────────────────
  const tiny = toLogoRaster(tinyImage(), 8, 2)
  const bytes = Buffer.from(tiny.data, 'base64')
  check('converter: black = ink, MSB left, transparent = paper', tiny.widthDots === 8 && tiny.heightDots === 2 &&
    bytes.length === 2 && bytes[0] === 0b10101010 && bytes[1] === 0, `${bytes[0]?.toString(2)} ${bytes[1]}`)
  const back = rasterToRgba(tiny)
  check('preview: ink is black, paper white', back[0] === 0 && back[4] === 255 && back[3] === 255)
  check('a lighter threshold prints less', Buffer.from(toLogoRaster(tinyImage(), 8, 2, 0).data, 'base64')[0] === 0)
  const tall = logoSize(100, 1000, 288)
  check('a tall image is capped at 600 dots, width a multiple of 8', tall.height <= 600 && tall.width % 8 === 0, JSON.stringify(tall))
  check('a wide image keeps its shape at the chosen width', JSON.stringify(logoSize(400, 200, 288)) === JSON.stringify({ width: 288, height: 144 }))

  // ── Settings ───────────────────────────────────────────────────────────────
  const tenantId = (await one(q`INSERT INTO tenants (name) VALUES ('ZZ Settings verify') RETURNING id`)).id as string
  tenantIds.push(tenantId)
  await db.execute(q`INSERT INTO tenant_config (tenant_id, restaurant_name) VALUES (${tenantId}, 'ZZ Old')`)
  const ownerId = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash) VALUES (${tenantId}, 'ZZ Olga', 'owner', 'x') RETURNING id`)).id as string
  const actor = { staffId: ownerId, tenantId }

  const loaded = (await loadSettings(db, tenantId))!
  check('load: defaults from a fresh restaurant', loaded.restaurantName === 'ZZ Old' && loaded.receiptHeader === '' &&
    loaded.receiptLogo === null && loaded.serviceChargeBp === 0 && loaded.businessDayStartHour === 4)

  const logo = toLogoRaster(new Uint8ClampedArray(16 * 4 * 4).fill(0), 16, 4)
  const good: SettingsInput = {
    restaurantName: '  ZZ  New Name ',
    receiptHeader: 'No 12, Galle Road\nHikkaduwa\nTel 011 234 5678\n\n',
    receiptFooter: 'Instagram @zzcafe\nThank you!',
    receiptQrUrl: 'https://g.page/r/ZZ/review',
    receiptQrCaption: 'Scan to review us',
    receiptLogo: logo,
    serviceChargeBp: 250,
    taxRatePercent: 5,
    defaultDiscountBp: 1000,
    kitchenTicketCopies: 2,
    barTicketCopies: 1,
    businessDayStartHour: 5,
  }
  const saved = await db.transaction((tx) => saveSettings(tx, actor, good, loaded.updatedAt))
  check('save: cleaned and stored', saved.restaurantName === 'ZZ New Name' && saved.receiptHeader === 'No 12, Galle Road\nHikkaduwa\nTel 011 234 5678' &&
    saved.serviceChargeBp === 250 && saved.taxRatePercent === 5 && saved.businessDayStartHour === 5 && saved.receiptLogo?.widthDots === 16)
  check('save: a new version', saved.updatedAt !== loaded.updatedAt)
  check('save: default discount and ticket copies', saved.defaultDiscountBp === 1000 && saved.kitchenTicketCopies === 2 && saved.barTicketCopies === 1)

  const payload = (await one(q`SELECT payload, table_name, staff_id FROM config_changes WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT 1`))
  check('the change is recorded, without the logo bytes', payload?.table_name === 'tenant_config' && payload.staff_id === ownerId &&
    payload.payload.logo === '16x4' && payload.payload.logoChanged === true && !JSON.stringify(payload.payload).includes(logo.data))

  const receipt: ReceiptPayload = {
    kind: 'receipt', destination: 'cashier', title: 'BILL', copy: false, restaurantName: saved.restaurantName,
    headerLines: [], footerLines: [], tableLabels: ['T1'], billLabel: null, printedAt: '2026-11-14T14:00:00Z',
    timeZone: 'Asia/Colombo', dailyNumber: 1, businessDate: '2026-11-14', lines: [], comps: [], subtotalPaisa: 0,
    serviceChargePaisa: 0, serviceChargeBp: 0, taxPaisa: 0, taxBp: 0, totalPaisa: 0, tenders: [], logo: saved.receiptLogo,
  } as ReceiptPayload
  check('the saved logo prints (the printer accepts it)', buildReceipt(receipt).toString('latin1').includes('\x1dv0'))

  let stale = false
  try {
    await db.transaction((tx) => saveSettings(tx, actor, good, loaded.updatedAt))
  } catch (error) {
    stale = error instanceof StaleVersionError
  }
  check('a save against an older version is refused', stale)

  const fieldOf = async (over: Partial<SettingsInput>) => {
    try {
      await db.transaction((tx) => saveSettings(tx, actor, { ...good, ...over }, saved.updatedAt))
      return null
    } catch (error) {
      return error instanceof SettingsFieldError ? error.field : String(error)
    }
  }
  check('invalid: empty name', (await fieldOf({ restaurantName: ' ' })) === 'restaurantName')
  check('invalid: 7 header lines', (await fieldOf({ receiptHeader: 'a\nb\nc\nd\ne\nf\ng' })) === 'receiptHeader')
  check('invalid: a footer line wider than the paper', (await fieldOf({ receiptFooter: 'x'.repeat(49) })) === 'receiptFooter')
  check('invalid: QR with a space, or not http(s)', (await fieldOf({ receiptQrUrl: 'https://a b' })) === 'receiptQrUrl' &&
    (await fieldOf({ receiptQrUrl: 'g.page/x' })) === 'receiptQrUrl')
  check('invalid: service charge over 30%', (await fieldOf({ serviceChargeBp: 3001 })) === 'serviceChargeBp')
  check('invalid: tax not a whole percent', (await fieldOf({ taxRatePercent: 2.5 })) === 'taxRatePercent')
  check('invalid: hour 24', (await fieldOf({ businessDayStartHour: 24 })) === 'businessDayStartHour')
  check('invalid logo: width not a multiple of 8', (await fieldOf({ receiptLogo: { ...logo, widthDots: 12 } })) === 'receiptLogo')
  check('invalid logo: data shorter than its size', (await fieldOf({ receiptLogo: { ...logo, heightDots: 5 } })) === 'receiptLogo')
  check('invalid logo: wider than the paper', (await fieldOf({ receiptLogo: { widthDots: 584, heightDots: 1, data: Buffer.alloc(73).toString('base64') } })) === 'receiptLogo')
  const unchanged = (await loadSettings(db, tenantId))!
  check('a refused save changes nothing', unchanged.updatedAt === saved.updatedAt && unchanged.serviceChargeBp === 250)

  // Review fixes.
  let badVersion = false
  try {
    await db.transaction((tx) => saveSettings(tx, actor, good, 'not a date'))
  } catch (error) {
    badVersion = error instanceof StaleVersionError
  }
  check('a version that is not a date is stale, not a crash', badVersion)
  check('control characters are cleaned out of the name', (await fieldOf({ restaurantName: '' })) === 'restaurantName')
  await db.transaction((tx) => saveSettings(tx, actor, good, saved.updatedAt))
  const second = await one(q`SELECT payload FROM config_changes WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT 1`)
  check('saving the same logo again records logoChanged: false', second.payload.logoChanged === false)
  await db.execute(q`UPDATE tenant_config SET receipt_logo = '{"widthDots": 0, "heightDots": 1, "data": ""}'::jsonb WHERE tenant_id = ${tenantId}`)
  const malformed = (await loadSettings(db, tenantId))!
  check('a malformed stored logo loads as none (no crash, saves still work)', malformed.receiptLogo === null)

  const removed = await db.transaction((tx) =>
    saveSettings(tx, actor, { ...good, receiptLogo: null, receiptQrUrl: '', receiptHeader: '' }, malformed.updatedAt))
  const raw = await one(q`SELECT receipt_logo, receipt_qr_url, receipt_header FROM tenant_config WHERE tenant_id = ${tenantId}`)
  check('remove logo, clear QR and header: stored as null (prints nothing)', removed.receiptLogo === null &&
    raw.receipt_logo === null && raw.receipt_qr_url === null && raw.receipt_header === null)
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = ((await db.execute(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Settings %'`)).rows as any[]).map((r) => r.id as string)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  try {
    await db.execute(q.raw('ALTER TABLE config_changes DISABLE TRIGGER immutable_config_changes'))
    await db.execute(q`DELETE FROM config_changes WHERE tenant_id = any(${all}::uuid[])`)
  } finally {
    await db.execute(q.raw('ALTER TABLE config_changes ENABLE TRIGGER immutable_config_changes')).catch((error) =>
      console.error('!! COULD NOT RE-ENABLE immutable_config_changes !!', error))
  }
  await db.execute(q`DELETE FROM staff WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM tenant_config WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM tenants WHERE id = any(${all}::uuid[])`)
}

run()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error('cleanup failed:', error))
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exit(results.every(Boolean) ? 0 : 1)
  })
