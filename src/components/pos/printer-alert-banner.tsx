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
export function PrinterAlertBanner() {
  // Keyed by job, so a job that retries four times replaces its own banner
  // rather than stacking four. A dead-letter overwrites the retrying notice for
  // the same job, which is exactly the transition staff need to see.
  const [alerts, setAlerts] = useState<Map<string, PrinterAlertPayload>>(new Map())

  useSocketEvent<PrinterAlertPayload>(
    'printer:alert',
    useCallback((payload: PrinterAlertPayload) => {
      setAlerts((current) => {
        const next = new Map(current)
        next.set(payload.jobId, payload)
        return next
      })
    }, []),
  )

  const dismiss = (jobId: string) =>
    setAlerts((current) => {
      const next = new Map(current)
      next.delete(jobId)
      return next
    })

  if (alerts.size === 0) return null

  const station = (destination: PrinterAlertPayload['destination']) =>
    destination === 'pizza_kitchen' ? 'pizza kitchen' : destination

  return (
    // Above the action strips (shadow-el-3, sticky bottom) and out of the way
    // of the header. `pointer-events-none` on the stack so the gap between
    // banners does not swallow taps meant for the screen underneath.
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col gap-sp-2 p-sp-3"
      aria-live="polite"
    >
      {[...alerts.values()].map((alert) => {
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
    </div>
  )
}
