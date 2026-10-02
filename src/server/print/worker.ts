/**
 * The print queue's worker (Story 5.0, Task 3).
 *
 * ── Standalone, like the session reaper ──────────────────────────────────────
 * Loaded by `server.ts`, a plain Node process outside Next's module graph.
 * `@/server/db`, `order.service.ts` and `socket/events.ts` all carry
 * `import 'server-only'`, whose default export THROWS there. So: its own `pg`
 * pool, plain SQL, no ORM. The precedent is `src/server/db/sweep-sessions.ts`.
 *
 * ── What it guarantees, and what it does not ─────────────────────────────────
 * Guaranteed: a queued ticket is attempted until it is delivered or
 * dead-lettered, in creation order, with backoff, and never by two workers at
 * once.
 *
 * NOT guaranteed: exactly-once delivery. See `recoverStaleClaims` — a job that
 * died mid-delivery cannot be told apart from one that was delivered but never
 * recorded, and this retries it. A duplicate ticket is a piece of paper; a
 * missing one is a table waiting for food that nobody is cooking.
 */
import { Pool } from 'pg'
import type { PrinterAlertPayload, TicketPayload } from '@/types/tickets'
import { resolveTransport, type TicketTransport } from './transport'

/**
 * The wait after failure N, before attempt N+1 (AC-4).
 *
 * Five waits, so a job is tried six times across roughly 53 seconds before it
 * is given up on. `MAX_ATTEMPTS` is deliberately one MORE than the ladder is
 * long: with five attempts the last rung was unreachable, the code performed
 * 1s/2s/5s/15s, and the comment here claimed a 30s wait that never happened —
 * found in review, and the reason these two constants are now defined against
 * each other rather than independently.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000]

/**
 * Claims before a job is dead-lettered (AC-6).
 *
 * `attempts` counts CLAIMS, and the ladder above is walked by the failures
 * between them, so the last claim has no wait after it — hence `+ 1`.
 */
const MAX_ATTEMPTS = BACKOFF_MS.length + 1

/**
 * How long a claim may sit in `printing` before another tick reclaims it.
 *
 * Longer than any plausible delivery: a TCP print is seconds at worst (Story
 * 5.2 times out at 5s). Short enough that a crash at 19:58 does not leave the
 * 20:00 rush's tickets stuck behind it.
 */
const STALE_CLAIM_MS = 2 * 60 * 1_000

let pool: Pool | undefined

/**
 * Set on the way to shutdown. The drain finishes the delivery it is on and
 * then stops CLAIMING — without it, a drain kept taking fresh jobs all the way
 * through the grace period, which is the opposite of draining down.
 */
let stopping = false

/** Called by `server.ts` on SIGTERM/SIGINT. */
export function stopPrintQueue(): void {
  stopping = true
}

function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('[print] DATABASE_URL is not set')
  // Small: one tick processes jobs one at a time, by design (see `drain`).
  pool = new Pool({ connectionString, max: 2 })
  pool.on('error', (error) => console.error('[print] Queue pool error:', error))
  return pool
}

/**
 * Closes the queue's pool. `server.ts` calls this on the way out.
 *
 * Without it `process.exit` was tearing down the connections underneath
 * PostgreSQL rather than closing them, on every deploy.
 */
export async function closePrintPool(): Promise<void> {
  const open = pool
  pool = undefined
  await open?.end()
}

type ClaimedJob = {
  id: string
  destination: TicketPayload['destination']
  ticket: TicketPayload
  attempts: number
}

/**
 * Returns a job stuck in `printing` to `pending`.
 *
 * ── The honest version of AC-7 ───────────────────────────────────────────────
 * `printing` means "a worker claimed this", NOT "this was not printed". The
 * worker may have written every byte and died before it could record the fact.
 * Nothing in the database can tell those apart, so this retries — and SAYS SO
 * in `last_error`, which is the only reason a second ticket on the spike has an
 * explanation.
 *
 * `attempts` is not incremented here: the claim already counted it.
 *
 * ── The crash loop is bounded HERE, not by the claim ─────────────────────────
 * This comment used to say the claim's increment was enough. It is not:
 * dead-lettering lives in `markFailed`, which only runs when `deliver()`
 * REJECTS. A job that kills the process mid-delivery never reaches it, so it
 * was recovered every two minutes for ever — `attempts` climbing past the
 * ceiling, never reaching `dead`, never alerting, and taking the POS down with
 * it each time if the crash was the job's fault. Found in review. Recovery
 * therefore checks the ceiling itself and dead-letters what is past it.
 */
async function recoverStaleClaims(): Promise<{ recovered: number; dead: number }> {
  const revived = await getPool().query(
    `UPDATE print_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            claimed_at = NULL,
            last_error = 'recovered from a stale claim — may already have printed'
      WHERE status = 'printing'
        AND claimed_at < now() - ($1 || ' milliseconds')::interval
        AND attempts < $2`,
    [STALE_CLAIM_MS, MAX_ATTEMPTS],
  )

  // Out of attempts and still stuck: the same end a repeated delivery failure
  // reaches, by the other road. The row stays, as always.
  const buried = await getPool().query<{ id: string; destination: TicketPayload['destination']; ticket: TicketPayload; attempts: number }>(
    `UPDATE print_jobs
        SET status = 'dead',
            claimed_at = NULL,
            last_error = 'gave up after repeatedly failing to survive delivery — may already have printed'
      WHERE status = 'printing'
        AND claimed_at < now() - ($1 || ' milliseconds')::interval
        AND attempts >= $2
    RETURNING id, destination, ticket, attempts`,
    [STALE_CLAIM_MS, MAX_ATTEMPTS],
  )

  for (const job of buried.rows) {
    console.error(`[print] Job ${job.id} (${job.destination}) dead-lettered after ${job.attempts} crashed attempts`)
    alertStaff({
      kind: 'dead',
      jobId: job.id,
      destination: job.destination,
      tableLabels: job.ticket.tableLabels,
      attempts: job.attempts,
      lastError: 'repeatedly failed to survive delivery',
    })
  }

  return { recovered: revived.rowCount ?? 0, dead: buried.rowCount ?? 0 }
}

/**
 * Takes the oldest ready job whose station is not already waiting on an older
 * one, or null.
 *
 * ── Head-of-line ordering, per destination (Teran, 2026-09-25) ──────────────
 * The `NOT EXISTS` is the whole of it: a job is claimable only when NOTHING
 * older for the same destination is still in play. "In play" means either
 * being delivered right now (`printing`) or waiting out a backoff (`pending`
 * with a future `next_attempt_at`).
 *
 * Without it, a ticket serving its backoff was simply invisible and the NEXT
 * round for the same kitchen was claimed ahead of it: the printer jams for ten
 * seconds and round 3 comes out before round 2, which is a kitchen cooking in
 * the wrong order. Three review layers found it independently.
 *
 * What it costs: while one kitchen ticket is retrying, later kitchen tickets
 * wait. That is bounded and short — the ladder is ~53 seconds, after which the
 * stuck job dead-letters and stops blocking, because `dead` is not "in play".
 * Other destinations are unaffected: a jammed kitchen printer never delays the
 * bar.
 *
 * `FOR UPDATE SKIP LOCKED` remains the concurrency control: two workers — two
 * ticks overlapping, or a second process during a deploy — step over each
 * other's rows instead of both claiming one and printing it twice.
 *
 * `attempts` increments HERE rather than on failure, so "attempts" means "times
 * a worker has taken this job" — a crash between claim and outcome counts, and
 * `recoverStaleClaims` reads the same number to decide when to give up.
 */
async function claimNextJob(): Promise<ClaimedJob | null> {
  const result = await getPool().query<ClaimedJob>(
    `UPDATE print_jobs
        SET status = 'printing', claimed_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT ready.id
          FROM print_jobs ready
         WHERE ready.status = 'pending'
           AND ready.next_attempt_at <= now()
           AND NOT EXISTS (
             SELECT 1
               FROM print_jobs ahead
              WHERE ahead.destination = ready.destination
                AND ahead.created_at < ready.created_at
                AND (
                  ahead.status = 'printing'
                  OR (ahead.status = 'pending' AND ahead.next_attempt_at > now())
                )
           )
         ORDER BY ready.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
    RETURNING id, destination, ticket, attempts`,
  )
  return result.rows[0] ?? null
}

/**
 * Records a delivery.
 *
 * `last_error` is KEPT, not cleared. It used to be set to NULL here, which
 * erased the one thing Trap 3 asks this design to leave behind: the note that a
 * recovered job may already have printed. The job succeeded on the attempt that
 * mattered; the trail of how it got there is the whole point of the column, and
 * `status = 'printed'` already says the outcome.
 */
async function markPrinted(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE print_jobs SET status = 'printed', printed_at = now() WHERE id = $1`,
    [jobId],
  )
}

/**
 * Tells the floor a ticket that HAD been failing has printed.
 *
 * Only for a job that already alerted (`attempts > 1`), because that is the
 * only banner there is to clear. Without this there was no recovery signal
 * anywhere: one transient failure left "the printer is not responding" pinned
 * to every device for the rest of service, since the only way a banner ever
 * disappeared was a staff member tapping it.
 */
function announceRecovery(job: ClaimedJob): void {
  if (job.attempts <= 1) return
  alertStaff({
    kind: 'recovered',
    jobId: job.id,
    destination: job.destination,
    tableLabels: job.ticket.tableLabels,
    attempts: job.attempts,
    lastError: '',
  })
}

/** Back to `pending` with the next attempt scheduled, or `dead` if out of tries. */
async function markFailed(job: ClaimedJob, error: unknown): Promise<'pending' | 'dead'> {
  const message = error instanceof Error ? error.message : String(error)
  const exhausted = job.attempts >= MAX_ATTEMPTS

  if (exhausted) {
    // NOT deleted. The row is the ticket's only remaining copy of the delivery
    // attempt, and the queue flushes it the moment someone re-queues it by hand
    // or Story 5.2's reprint arrives.
    await getPool().query(
      `UPDATE print_jobs SET status = 'dead', claimed_at = NULL, last_error = $2 WHERE id = $1`,
      [job.id, message],
    )
    return 'dead'
  }

  const waitMs = BACKOFF_MS[Math.min(job.attempts, BACKOFF_MS.length) - 1]
  await getPool().query(
    `UPDATE print_jobs
        SET status = 'pending',
            claimed_at = NULL,
            last_error = $2,
            next_attempt_at = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1`,
    [job.id, message, waitMs],
  )
  return 'pending'
}

/**
 * Tells the floor a ticket is in trouble (AC-6; Change U3).
 *
 * Broadcast, not room-scoped, since Story 5.2: the payload carries no guest
 * data — station, tables, attempt count — and the people who can act on it are
 * the waiter who sent the round and whoever is near the kitchen. Nothing joins
 * the owner room until Epic 9, so the previous owner-only emit reached nobody.
 *
 * Reaches Socket.io through `global.__io` rather than `emitPrinterAlert`,
 * because that module is `server-only` and this file is not loaded by Next. It
 * is the same server instance `server.ts` created — `src/server/socket/index.ts`
 * reads the same global.
 *
 * A failed emit must never fail the queue: the row already records everything.
 */
function alertStaff(payload: PrinterAlertPayload): void {
  try {
    const io = globalThis.__io
    if (!io) return
    io.emit('printer:alert', payload)
  } catch (error) {
    console.error('[print] Could not emit printer:alert:', error)
  }
}

/**
 * Drains the queue until nothing is ready, then returns.
 *
 * ── One job at a time ────────────────────────────────────────────────────────
 * One in-flight delivery, so one blocked printer cannot consume a pool of
 * workers and two tickets can never be on the wire at once.
 *
 * ── A station's tickets keep their order (AC-3, AC-5) ────────────────────────
 * Two things make that true, and both were added after the 2026-09-25 review
 * found the first version claiming it without delivering it:
 *
 * 1. `claimNextJob` will not take a job while an OLDER one for the same
 *    destination is printing or waiting out a backoff. A failing ticket holds
 *    its own station's queue rather than being quietly overtaken.
 * 2. `print_jobs.created_at` defaults to `clock_timestamp()`, not `now()`.
 *    `now()` is the TRANSACTION timestamp, so two concurrent sends could be
 *    queued in the reverse of the order they actually committed.
 *
 * A blocked station is bounded by the retry ladder and the transport's own
 * per-attempt budget: 53 seconds of waiting plus six attempts × 5 seconds of
 * blocking, so about 83 seconds before the stuck job dead-letters and stops
 * blocking. (The ladder alone was quoted here until Story 5.2's review pointed
 * out that a real socket takes time to fail.)
 *
 * Other DESTINATIONS are not blocked by the claim rule — but they do share one
 * printer today, because `resolveTransport` sends every destination to the
 * same `PRINTER_IP` until Story 10.3 gives stations their own. So "a jammed
 * kitchen printer does not delay the bar" is true of the queue and false of
 * the hardware, and will stay false until there are two printers.
 *
 * Returns what happened, for the caller's log line.
 *
 * `resolve` is a parameter rather than a hard-wired import so a printer that
 * refuses, times out or dies mid-write can be produced on demand. Retry,
 * backoff, dead-lettering and stale-claim recovery are the whole point of this
 * file and none of them can be exercised by a transport that always succeeds —
 * which, until Story 5.2, is the only one that exists. `server.ts` passes
 * nothing and gets the real resolver.
 */
export async function drainPrintQueue(
  resolve: (destination: TicketPayload['destination']) => TicketTransport = resolveTransport,
): Promise<{
  printed: number
  failed: number
  dead: number
  recovered: number
}> {
  const recovery = await recoverStaleClaims()
  if (recovery.recovered > 0) {
    console.warn(`[print] Recovered ${recovery.recovered} stale claim(s) — they may print twice`)
  }

  let printed = 0
  let failed = 0
  let dead = recovery.dead

  for (;;) {
    if (stopping) break // finish what is in flight, claim nothing new
    const job = await claimNextJob()
    if (!job) break

    // ── Deliver, then record, in two separate steps ────────────────────────
    // `markPrinted` used to sit inside this try. A delivery that SUCCEEDED and
    // a status write that then failed — pool exhausted, Postgres restarting, a
    // severed connection — was caught here and booked as a print failure: the
    // ticket was re-queued and printed again, or dead-lettered with an alert
    // while sitting on the spike. Found in review. What the transport does and
    // what the database records about it are now separate failures.
    try {
      await resolve(job.destination).deliver(job.ticket)
    } catch (error) {
      try {
        const outcome = await markFailed(job, error)
        const alert = {
          jobId: job.id,
          destination: job.destination,
          tableLabels: job.ticket.tableLabels,
          attempts: job.attempts,
          lastError: error instanceof Error ? error.message : String(error),
        }
        if (outcome === 'dead') {
          dead += 1
          console.error(
            `[print] Job ${job.id} (${job.destination}) dead-lettered after ${job.attempts} attempts`,
          )
          alertStaff({ kind: 'dead', ...alert })
        } else {
          failed += 1
          // Change U3: "queued and retrying" is a DIFFERENT message from "gave
          // up", and staff need the first one — a ticket that is 30 seconds
          // late is worth knowing about before it is dead. The banner says the
          // system is still working on it and asks for nothing.
          alertStaff({ kind: 'retrying', ...alert })
        }
      } catch (writeError) {
        // The database is in trouble too. Leave the row `printing`; the
        // stale-claim sweep reclaims it in two minutes. Do NOT rethrow — an
        // escape here abandoned every other ready job for the whole tick.
        console.error(`[print] Job ${job.id}: could not record the failure:`, writeError)
      }
      continue
    }

    try {
      await markPrinted(job.id)
      printed += 1
      announceRecovery(job)
    } catch (error) {
      // The ticket IS printed. Only the record failed, so this must not look
      // like a delivery failure: the row stays `printing`, the stale sweep
      // retries it in two minutes, and `recoverStaleClaims` writes the "may
      // already have printed" note that explains the duplicate.
      console.error(`[print] Job ${job.id} delivered but could not be marked printed:`, error)
    }
  }

  return { printed, failed, dead, recovered: recovery.recovered }
}
