import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { sql } from 'drizzle-orm'

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`)

    return NextResponse.json(
      { status: 'ok', db: 'connected', uptime: Math.floor(process.uptime()) },
      { status: 200 }
    )
  } catch {
    return NextResponse.json(
      { status: 'degraded', db: 'error' },
      { status: 503 }
    )
  }
}
