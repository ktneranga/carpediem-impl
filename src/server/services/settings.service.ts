import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { tenantConfig, tenants } from '@/server/db/schema'
import { recordConfigChange } from '@/server/services/config-change.service'
import { MenuRuleError, StaleVersionError } from '@/server/services/menu-admin.service'
import { logoPrints } from '@/server/print/escpos'
import type { LogoRaster } from '@/lib/logo-raster'

/**
 * Manage → Settings (spec-restaurant-settings): what the bill prints and the
 * rates new bills use. One row per restaurant (`tenant_config`) plus the
 * business-day hour on `tenants`.
 *
 * ── `updated_at` is the version ──────────────────────────────────────────────
 * The editor sends back the `updatedAt` it loaded; a save against a newer one
 * is refused (StaleVersionError → 409), never a silent overwrite.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Executor = Tx | typeof db

export type Settings = {
  restaurantName: string
  receiptHeader: string
  receiptFooter: string
  receiptQrUrl: string
  receiptQrCaption: string
  receiptLogo: LogoRaster | null
  /** Basis points: 1000 = 10%. */
  serviceChargeBp: number
  /** Whole percent (the column is an integer). */
  taxRatePercent: number
  /** The discount every order starts with, basis points (Teran, 2026-11-16). */
  defaultDiscountBp: number
  /** Copies of each KOT / KOT-P and each BOT, 1 to 3. */
  kitchenTicketCopies: number
  barTicketCopies: number
  businessDayStartHour: number
  /** ISO; the version. */
  updatedAt: string
}

export type SettingsInput = Omit<Settings, 'updatedAt'>
export type SettingsField = keyof SettingsInput

export class SettingsFieldError extends MenuRuleError {
  constructor(readonly field: SettingsField, message: string) {
    super(message)
  }
}

export const MAX_TEXT_LINES = 6
export const MAX_LINE_LENGTH = 48

export async function loadSettings(executor: Executor, tenantId: string): Promise<Settings | null> {
  const [row] = await executor
    .select({
      restaurantName: tenantConfig.restaurantName,
      receiptHeader: tenantConfig.receiptHeader,
      receiptFooter: tenantConfig.receiptFooter,
      receiptQrUrl: tenantConfig.receiptQrUrl,
      receiptQrCaption: tenantConfig.receiptQrCaption,
      receiptLogo: tenantConfig.receiptLogo,
      serviceChargeBp: tenantConfig.serviceChargeBp,
      taxRatePercent: tenantConfig.taxRatePercent,
      defaultDiscountBp: tenantConfig.defaultDiscountBp,
      kitchenTicketCopies: tenantConfig.kitchenTicketCopies,
      barTicketCopies: tenantConfig.barTicketCopies,
      businessDayStartHour: tenants.businessDayStartHour,
      updatedAt: tenantConfig.updatedAt,
    })
    .from(tenantConfig)
    .innerJoin(tenants, eq(tenants.id, tenantConfig.tenantId))
    .where(eq(tenantConfig.tenantId, tenantId))
    .limit(1)
  if (!row) return null
  return {
    restaurantName: row.restaurantName,
    receiptHeader: row.receiptHeader ?? '',
    receiptFooter: row.receiptFooter ?? '',
    receiptQrUrl: row.receiptQrUrl ?? '',
    receiptQrCaption: row.receiptQrCaption ?? '',
    // A malformed stored logo (old data, hand-written SQL) loads as none, so it
    // can neither crash the preview nor block every save.
    receiptLogo: safeLogo(row.receiptLogo),
    serviceChargeBp: row.serviceChargeBp,
    taxRatePercent: row.taxRatePercent,
    defaultDiscountBp: row.defaultDiscountBp,
    kitchenTicketCopies: row.kitchenTicketCopies,
    barTicketCopies: row.barTicketCopies,
    businessDayStartHour: row.businessDayStartHour,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** The printer's own check (`escpos.logoPrints`), plus strict base64, so a saved logo always prints. */
export function checkLogo(logo: unknown): LogoRaster | null {
  if (logo === null) return null
  const fail = (): never => {
    throw new SettingsFieldError('receiptLogo', 'The logo could not be read. Choose the image again.')
  }
  if (typeof logo !== 'object') return fail()
  const { widthDots, heightDots, data } = logo as Record<string, unknown>
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return fail()
  if (!logoPrints({ widthDots, heightDots, data })) return fail()
  return { widthDots: widthDots as number, heightDots: heightDots as number, data }
}

function safeLogo(logo: unknown): LogoRaster | null {
  try {
    return logo ? checkLogo(logo) : null
  } catch {
    return null
  }
}

/** Control characters out (they print as garbage), then spaces folded. */
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')

function checkLines(field: 'receiptHeader' | 'receiptFooter', label: string, text: string): string {
  const lines = clean(text.replace(/\r\n?/g, '\n')).split('\n').map((line) => line.trim())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length > MAX_TEXT_LINES) throw new SettingsFieldError(field, `${label}: at most ${MAX_TEXT_LINES} lines`)
  if (lines.some((line) => line.length > MAX_LINE_LENGTH)) {
    throw new SettingsFieldError(field, `${label}: at most ${MAX_LINE_LENGTH} characters a line (the paper's width)`)
  }
  return lines.join('\n')
}

/** Cleans and checks every field; throws a `SettingsFieldError` naming the first wrong one. */
export function checkSettings(input: SettingsInput): SettingsInput {
  const restaurantName = clean(input.restaurantName).trim().replace(/\s+/g, ' ')
  if (restaurantName.length < 1 || restaurantName.length > 60) {
    throw new SettingsFieldError('restaurantName', 'The restaurant name is 1 to 60 characters')
  }
  const receiptHeader = checkLines('receiptHeader', 'Header', input.receiptHeader)
  const receiptFooter = checkLines('receiptFooter', 'Footer', input.receiptFooter)

  const receiptQrUrl = input.receiptQrUrl.trim()
  if (receiptQrUrl && !/^https?:\/\/[\x21-\x7e]{1,292}$/.test(receiptQrUrl)) {
    throw new SettingsFieldError('receiptQrUrl', 'The QR link starts with http:// or https:// and has no spaces')
  }
  const receiptQrCaption = clean(input.receiptQrCaption).trim().replace(/\s+/g, ' ')
  if (receiptQrCaption.length > MAX_LINE_LENGTH) {
    throw new SettingsFieldError('receiptQrCaption', `The QR caption is at most ${MAX_LINE_LENGTH} characters`)
  }

  if (!Number.isInteger(input.serviceChargeBp) || input.serviceChargeBp < 0 || input.serviceChargeBp > 3000) {
    throw new SettingsFieldError('serviceChargeBp', 'Service charge is 0% to 30%, up to two decimals')
  }
  if (!Number.isInteger(input.taxRatePercent) || input.taxRatePercent < 0 || input.taxRatePercent > 30) {
    throw new SettingsFieldError('taxRatePercent', 'Tax is a whole percent, 0 to 30')
  }
  if (!Number.isInteger(input.defaultDiscountBp) || input.defaultDiscountBp < 0 || input.defaultDiscountBp > 10_000) {
    throw new SettingsFieldError('defaultDiscountBp', 'Discount is 0% to 100%, up to two decimals')
  }
  for (const field of ['kitchenTicketCopies', 'barTicketCopies'] as const) {
    if (!Number.isInteger(input[field]) || input[field] < 1 || input[field] > 3) {
      throw new SettingsFieldError(field, 'Copies: 1, 2 or 3')
    }
  }
  if (!Number.isInteger(input.businessDayStartHour) || input.businessDayStartHour < 0 || input.businessDayStartHour > 23) {
    throw new SettingsFieldError('businessDayStartHour', 'Choose an hour from 0 to 23')
  }
  return {
    restaurantName,
    receiptHeader,
    receiptFooter,
    receiptQrUrl,
    receiptQrCaption,
    receiptLogo: checkLogo(input.receiptLogo),
    serviceChargeBp: input.serviceChargeBp,
    taxRatePercent: input.taxRatePercent,
    defaultDiscountBp: input.defaultDiscountBp,
    kitchenTicketCopies: input.kitchenTicketCopies,
    barTicketCopies: input.barTicketCopies,
    businessDayStartHour: input.businessDayStartHour,
  }
}

/** Saves, refusing a save made against an older version (`expectedUpdatedAt`). */
export async function saveSettings(
  tx: Tx,
  actor: { staffId: string; tenantId: string },
  raw: SettingsInput,
  expectedUpdatedAt: string,
): Promise<Settings> {
  const input = checkSettings(raw)
  const [current] = await tx
    .select({ id: tenantConfig.id, updatedAt: tenantConfig.updatedAt, logo: tenantConfig.receiptLogo })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, actor.tenantId))
    .for('update')
    .limit(1)
  if (!current) throw new MenuRuleError('This restaurant has no settings row')
  const expected = new Date(expectedUpdatedAt)
  // Not a date at all is as stale as an old one: reload and try again.
  if (Number.isNaN(expected.getTime()) || current.updatedAt.toISOString() !== expected.toISOString()) throw new StaleVersionError()

  await tx
    .update(tenantConfig)
    .set({
      restaurantName: input.restaurantName,
      // Empty means "print nothing", stored as null like before.
      receiptHeader: input.receiptHeader || null,
      receiptFooter: input.receiptFooter || null,
      receiptQrUrl: input.receiptQrUrl || null,
      receiptQrCaption: input.receiptQrCaption || null,
      receiptLogo: input.receiptLogo,
      serviceChargeBp: input.serviceChargeBp,
      taxRatePercent: input.taxRatePercent,
      defaultDiscountBp: input.defaultDiscountBp,
      kitchenTicketCopies: input.kitchenTicketCopies,
      barTicketCopies: input.barTicketCopies,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(tenantConfig.id, current.id))
  await tx.update(tenants).set({ businessDayStartHour: input.businessDayStartHour }).where(eq(tenants.id, actor.tenantId))

  const previous = await tx.execute(sql`select count(*)::int as n from config_changes where table_name = 'tenant_config' and row_id = ${current.id}`)
  const { receiptLogo, ...rest } = input
  await recordConfigChange(tx, {
    tenantId: actor.tenantId,
    tableName: 'tenant_config',
    rowId: current.id,
    version: Number((previous.rows[0] as { n: number }).n) + 1,
    // Never the logo's bytes: a note that it changed, or was removed.
    payload: { ...rest, logo: receiptLogo ? `${receiptLogo.widthDots}x${receiptLogo.heightDots}` : null, logoChanged: !sameLogo(receiptLogo, current.logo ?? null) },
    staffId: actor.staffId,
  })
  return (await loadSettings(tx, actor.tenantId))!
}

/** Field by field: jsonb returns its keys in its own order, so JSON strings never compare equal. */
function sameLogo(a: LogoRaster | null, b: LogoRaster | null): boolean {
  if (!a || !b) return a === b
  return a.widthDots === b.widthDots && a.heightDots === b.heightDots && a.data === b.data
}
