'use client'

import { useCallback, useState } from 'react'
import { AlertTriangle, Printer, X } from 'lucide-react'
import { useSocketEvent } from '@/hooks/use-socket'
import type { PrinterAlertPayload } from '@/types/tickets'
import { cn } from '@/lib/utils'

/**
 * What the floor sees when a ticket cannot reach its printer (Change U3).
 *
 * ── Two states, deliberately different ───────────────────────────────────────
 * The old design had one persistent banner meaning "printer failed, reprint
 * manually". Two things changed under it: the queue retries on its own now, and
 * manual reprint is no longer how anything is recovered. So:
 *
 * - **retrying** — amber, informational, and it says the system is still
 *   trying. It asks for nothing. A ticket thirty seconds late is worth knowing
 *   about, but sending someone to the kitchen over it is worse than useless.
 * - **stopped** — red, and it asks for attention. The queue has given up; the
 *   ticket is still in `print_jobs` and still recoverable, which is why the
 *   wording is "has not printed", not "was lost".
 *
 * Neither auto-dismisses: a toast that vanishes while a waiter is carrying
 * plates has told nobody anything. A staff member closes it.
 *
 * ── Why it is mounted globally ───────────────────────────────────────────────
 * In `providers.tsx`, so it is present on the floor, the order screen and
 * anywhere else. A printer fails while somebody is mid-order, and the screen
 * they happen to be on should not decide whether they find out.
 *
 * It renders nothing until an alert arrives, so the cost on every other screen
 * is one socket listener.
 */
/** Above this many, the rest collapse into a count — see the stack comment. */
const MAX_VISIBLE = 3

export function PrinterAlertBanner() {
  // Keyed by job, so a job that retries four times replaces its own banner
  // rather than stacking four. A dead-letter overwrites the retrying notice for
  // the same job, which is exactly the transition staff need to see.
  const [alerts, setAlerts] = useState<Map<string, PrinterAlertPayload>>(new Map())
  // Jobs a staff member has closed. Without this, dismissing did nothing: the
  // next retry for the same job — up to five, seconds apart — put the banner
  // straight back, and the only way to be rid of it was to out-tap the queue.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useSocketEvent<PrinterAlertPayload>(
    'printer:alert',
    useCallback((payload: PrinterAlertPayload) => {
      // A ticket that recovered needs no banner — and clearing its old one is
      // the only way a "still trying" notice ever goes away by itself. It also
      // resets the dismissal, so a LATER failure of the same job is heard.
      if (payload.kind === 'recovered') {
        setAlerts((current) => {
          if (!current.has(payload.jobId)) return current
          const next = new Map(current)
          next.delete(payload.jobId)
          return next
        })
        setDismissed((current) => {
          if (!current.has(payload.jobId)) return current
          const next = new Set(current)
          next.delete(payload.jobId)
          return next
        })
        return
      }

      setAlerts((current) => {
        const next = new Map(current)
        next.set(payload.jobId, payload)
        return next
      })
    }, []),
  )

  const dismiss = (jobId: string) => {
    setAlerts((current) => {
      const next = new Map(current)
      next.delete(jobId)
      return next
    })
    setDismissed((current) => new Set(current).add(jobId))
  }

  const dismissAll = () => {
    setDismissed((current) => {
      const next = new Set(current)
      for (const jobId of alerts.keys()) next.add(jobId)
      return next
    })
    setAlerts(new Map())
  }

  const showing = [...alerts.values()].filter((alert) => !dismissed.has(alert.jobId))
  const visible = showing.slice(0, MAX_VISIBLE)
  const hidden = showing.length - visible.length

  const station = (destination: PrinterAlertPayload['destination']) =>
    destination === 'pizza_kitchen' ? 'pizza kitchen' : destination

  return (
    // ── The container is ALWAYS rendered ──────────────────────────────────
    // It used to return null until the first alert, which meant the live
    // region arrived in the DOM together with its content — and assistive
    // technology announces MUTATIONS to regions that already exist, so the
    // first alert, the one that most needs announcing, was silent.
    //
    // Pinned below the header rather than over it (`top-16`): the first
    // version said it stayed out of the header's way and then covered it.
    // `pointer-events-none` on the stack so the gaps between banners do not
    // swallow taps meant for the screen underneath.
    <div
      className="pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col gap-sp-2 p-sp-3"
      aria-live="polite"
    >
      {visible.map((alert) => {
        const stopped = alert.kind === 'dead'
        return (
          <div
            key={alert.jobId}
            role={stopped ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex items-center gap-sp-3 rounded-card border-2 px-sp-4 py-sp-3 shadow-el-3',
              stopped
                ? 'border-unavailable-edge bg-unavailable-body'
                : 'border-occupied-edge bg-occupied-body',
            )}
          >
            {stopped ? (
              <AlertTriangle
                aria-hidden="true"
                strokeWidth={2.5}
                className="size-6 shrink-0 text-unavailable-ink"
              />
            ) : (
              <Printer
                aria-hidden="true"
                strokeWidth={2.5}
                className="size-6 shrink-0 text-occupied-ink"
              />
            )}

            <div className="flex min-w-0 flex-col">
              <span
                className={cn(
                  'text-fs-16 font-bold',
                  stopped ? 'text-unavailable-ink' : 'text-occupied-ink',
                )}
              >
                {stopped
                  ? `The ${station(alert.destination)} ticket has not printed`
                  : `The ${station(alert.destination)} printer is not responding`}
              </span>
              <span
                className={cn(
                  'truncate text-fs-14',
                  stopped ? 'text-unavailable-ink' : 'text-occupied-ink',
                )}
              >
                {alert.tableLabels.join(' + ') || 'Counter'}
                {stopped
                  ? ` · gave up after ${alert.attempts} attempts — check the printer, the ticket is still queued`
                  : ` · still trying (attempt ${alert.attempts})`}
              </span>
            </div>

            <button
              type="button"
              onClick={() => dismiss(alert.jobId)}
              aria-label="Dismiss"
              className={cn(
                'ml-auto flex size-touch-standard shrink-0 items-center justify-center rounded-control',
                stopped ? 'text-unavailable-ink' : 'text-occupied-ink',
              )}
            >
              <X aria-hidden="true" strokeWidth={2.5} className="size-5" />
            </button>
          </div>
        )
      })}

      {/* ── The stack is capped ────────────────────────────────────────────
          A ten-minute outage dead-letters every round in turn, and a dead job
          does not block its station, so they accumulate. Twenty rounds was
          twenty permanent banners covering the viewport on every tablet and
          the kitchen display, each intercepting taps, clearable only one at a
          time — exactly when the POS is needed most. Three, a count, and one
          control that clears the lot. */}
      {hidden > 0 ? (
        <div className="pointer-events-auto flex items-center gap-sp-3 rounded-card border-2 border-slate-200 bg-white px-sp-4 py-sp-2 shadow-el-2">
          <span className="text-fs-14 font-semibold text-slate-600">
            and {hidden} more ticket{hidden === 1 ? '' : 's'} waiting on a printer
          </span>
        </div>
      ) : null}

      {showing.length > 1 ? (
        <button
          type="button"
          onClick={dismissAll}
          className="pointer-events-auto self-end rounded-control border border-slate-200 bg-white px-sp-4 py-sp-2 text-fs-14 font-semibold text-slate-600 shadow-el-1"
        >
          Dismiss all ({showing.length})
        </button>
      ) : null}
    </div>
  )
}
