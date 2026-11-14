import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { NextResponse, type NextRequest } from 'next/server'
import {
  dumpFilename,
  installationTenant,
  recordExport,
  validateVendorSession,
  VENDOR_COOKIE_NAME,
  vendorConfigured,
} from '@/server/services/vendor.service'

/**
 * The whole database as a `pg_dump` custom-format file, streamed to the vendor
 * (spec-11-1-vendor-access-export). Nothing is written on the server.
 *
 * ── A failure is never a 200 with a broken file ──────────────────────────────
 * The response waits for pg_dump's FIRST byte (or its exit). A dump that fails
 * before writing anything — wrong password, version mismatch, database down —
 * is a 502 and is not recorded. One that fails part-way errors the stream, so
 * the browser shows the download as failed instead of saving a cut-off file.
 *
 * ── The password is not on the command line ──────────────────────────────────
 * pg_dump gets the connection without the password, and the password in
 * PGPASSWORD, so `ps` inside the container shows no secret and pg_dump's own
 * errors cannot quote it.
 */
export const dynamic = 'force-dynamic'

/** One export at a time: a second click must not put a second full dump on the live POS. */
let running = false

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

export async function GET(request: NextRequest) {
  // Turned off since the cookie was issued (secret removed, restart): stop.
  if (!vendorConfigured()) return fail('VENDOR_DISABLED', 'Vendor access is off on this installation', 503)

  const session = await validateVendorSession(request.cookies.get(VENDOR_COOKIE_NAME)?.value).catch((error) => {
    console.error('[api/vendor/export] Session check failed:', error)
    return null
  })
  if (!session) {
    // A click on the link after the 30 minutes: back to the sign-in form, not a JSON page.
    if (request.headers.get('accept')?.includes('text/html')) return NextResponse.redirect(new URL('/vendor', request.url))
    return fail('VENDOR_SIGN_IN_REQUIRED', 'Sign in at /vendor first', 401)
  }

  let target: URL
  try {
    target = new URL(process.env.DATABASE_URL ?? '')
  } catch {
    return fail('INTERNAL_ERROR', 'The database is not configured', 500)
  }
  if (running) return fail('EXPORT_RUNNING', 'An export is already running. Wait for it to finish.', 409)

  // Named before anything is recorded, so a bad zone cannot fail after the fact.
  const tenant = await installationTenant().catch(() => null)
  let filename: string
  try {
    filename = dumpFilename(new Date(), tenant?.timeZone ?? 'UTC')
  } catch {
    filename = dumpFilename(new Date(), 'UTC')
  }

  const password = decodeURIComponent(target.password)
  target.password = ''
  running = true
  const child = spawn(process.env.PG_DUMP_PATH || 'pg_dump', ['--format=custom', '--no-owner', `--dbname=${target.toString()}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGPASSWORD: password },
  })
  let stderr = ''
  let spawnFailed = false
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000)
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      running = false
      // Killed on purpose (the browser cancelled) is not an error.
      if (code !== 0 && !signal && !spawnFailed) console.error(`[api/vendor/export] pg_dump exited ${code}:`, stderr)
      resolve({ code, signal })
    })
  })
  const kill = () => {
    if (child.exitCode === null && !child.killed) child.kill()
  }

  // Not found, or started? Then: first byte, or an early exit?
  const started = await new Promise<true | NodeJS.ErrnoException>((resolve) => {
    child.once('spawn', () => resolve(true))
    child.once('error', (error) => resolve(error))
  })
  if (started !== true) {
    spawnFailed = true
    running = false
    console.error('[api/vendor/export] pg_dump could not start:', started.code ?? started.message)
    return started.code === 'ENOENT'
      ? fail('PG_DUMP_MISSING', 'pg_dump is not installed where the app runs', 503)
      : fail('INTERNAL_ERROR', 'Could not start the export', 500)
  }
  const first = await Promise.race([
    new Promise<'data'>((resolve) => child.stdout.once('readable', () => resolve('data'))),
    exited.then(() => 'exit' as const),
  ])
  // "readable" also fires at end-of-stream with nothing in it: no bytes means
  // pg_dump wrote nothing, whichever event came first.
  void first
  if (child.stdout.readableLength === 0) {
    await exited
    return fail('EXPORT_FAILED', 'The export failed. See the server log.', 502)
  }
  if (request.signal.aborted) {
    kill()
    return fail('ABORTED', 'The download was cancelled', 499)
  }

  try {
    await recordExport(session.tenantId)
  } catch (error) {
    // No record, no export: the owner must be able to see every one.
    kill()
    console.error('[api/vendor/export] Could not record the export:', error)
    return fail('INTERNAL_ERROR', 'Could not record the export', 500)
  }

  // Part-way failure: error the stream so the download fails visibly.
  void exited.then(({ code, signal }) => {
    if (code !== 0 && !signal) child.stdout.destroy(new Error(`pg_dump exited ${code}`))
  })
  request.signal.addEventListener('abort', kill, { once: true })

  return new Response(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
