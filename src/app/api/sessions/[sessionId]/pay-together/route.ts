import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listOpenOrdersToPay } from '@/server/services/pay-together.service'

/**
 * The other open orders this one could be paid together with, and what each
 * owes (Teran, 2026-11-16). Owner and waiters (`/api/sessions`).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ success: false, error: { code: 'INVALID_SESSION_ID', message: 'Session id must be a UUID' } }, { status: 400 })
  }
  try {
    return NextResponse.json({ success: true, data: await listOpenOrdersToPay(sessionId) })
  } catch (error) {
    console.error('[api/sessions/:sessionId/pay-together] Failed:', error)
    return NextResponse.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Could not load the open orders' } }, { status: 500 })
  }
}
