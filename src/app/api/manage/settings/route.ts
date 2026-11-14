import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { MenuRuleError, StaleVersionError } from '@/server/services/menu-admin.service'
import { loadSettings, saveSettings, SettingsFieldError } from '@/server/services/settings.service'

/**
 * Manage → Settings (spec-restaurant-settings). Behind both Manage gates via
 * the `/api/manage` prefix. A logo is at most 576 × 600 dots = 43 KB, about
 * 58 KB in base64; the body is capped well above that.
 */
const MAX_BODY_BYTES = 200_000

const bodySchema = z.object({
  restaurantName: z.string().max(200),
  receiptHeader: z.string().max(2000),
  receiptFooter: z.string().max(2000),
  receiptQrUrl: z.string().max(400),
  receiptQrCaption: z.string().max(200),
  receiptLogo: z.object({ widthDots: z.number(), heightDots: z.number(), data: z.string().max(80_000) }).nullable(),
  serviceChargeBp: z.number(),
  taxRatePercent: z.number(),
  businessDayStartHour: z.number(),
  updatedAt: z.string().max(40),
})

const FIELD_LABELS: Record<string, string> = {
  restaurantName: 'The restaurant name',
  receiptHeader: 'The header',
  receiptFooter: 'The footer',
  receiptQrUrl: 'The QR link',
  receiptQrCaption: 'The QR caption',
  receiptLogo: 'The logo',
  serviceChargeBp: 'The service charge',
  taxRatePercent: 'The tax',
  businessDayStartHour: 'The business-day hour',
}

function fieldFail(field: string, message: string) {
  return NextResponse.json({ success: false, error: { code: 'INVALID', message, field } }, { status: 422 })
}

export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const settings = await loadSettings(db, actor.tenantId)
    if (!settings) return menuFail('NOT_FOUND', 'No settings for this restaurant', 404)
    return NextResponse.json({ success: true, data: settings })
  } catch (error) {
    console.error('[api/manage/settings] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the settings', 500)
  }
}

export async function PUT(request: Request) {
  // Refused before reading, when the size is declared.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return menuFail('TOO_LARGE', 'The logo is too large. Choose a smaller size.', 413)
  }
  const text = await request.text().catch(() => '')
  if (text.length > MAX_BODY_BYTES) return menuFail('TOO_LARGE', 'The logo is too large. Choose a smaller size.', 413)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return menuFail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    // Name the field, like every other refusal on this page.
    const field = String(parsed.error.issues[0]?.path[0] ?? '')
    return field && field !== 'updatedAt'
      ? fieldFail(field, `${FIELD_LABELS[field] ?? 'A setting'} is too long or not valid`)
      : menuFail('INVALID_BODY', 'Check the settings and save again', 400)
  }
  const { updatedAt, ...input } = parsed.data

  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const saved = await db.transaction((tx) => saveSettings(tx, actor, input, updatedAt))
    return NextResponse.json({ success: true, data: saved })
  } catch (error) {
    if (error instanceof SettingsFieldError) return fieldFail(error.field, error.message)
    if (error instanceof StaleVersionError) return menuFail('STALE', 'Someone else changed the settings. They have been reloaded.', 409)
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error('[api/manage/settings] Save failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not save the settings', 500)
  }
}
