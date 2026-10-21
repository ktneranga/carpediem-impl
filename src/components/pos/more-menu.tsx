'use client'

import { secondaryButtonClass } from '@/components/pos/action-strip-chrome'
import { cn } from '@/lib/utils'

/**
 * The "More" menu on an action strip (2026-10-16 design, shared 2026-10-21).
 *
 * ── Why a menu rather than another button on the row ─────────────────────────
 * "Take out of service" used to sit on the main row of every free table, one
 * tap from "Start order" and the same size. Teran asked for it behind a menu
 * precisely because of that: taking a table off the floor by accident is quiet
 * — the card goes grey, the table stops being offered, and nobody notices until
 * a party is standing in front of it.
 *
 * So a destructive item is two taps away, last in the list, and red. It still
 * leads to whatever confirmation the caller provides, which is the real one.
 *
 * ── One copy, two strips ─────────────────────────────────────────────────────
 * The floor strip and the order strip both draw this, in the same place, doing
 * the same thing. The order design puts "More" on its bar for exactly the same
 * reason the floor has one: to keep the row down to the actions a waiter takes
 * every time, and move the rest one tap away.
 *
 * Items are supplied, never invented here. A menu item that does nothing is the
 * dead-control defect this project has shipped twice.
 */
export function MoreMenu({
  items,
  busy,
  open,
  onOpenChange,
}: {
  items: { label: string; onClick: () => void; danger?: boolean }[]
  busy: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (items.length === 0) return null

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={secondaryButtonClass}
      >
        More
      </button>

      {open ? (
        <>
          {/* Tap-away closes it. A transparent full-screen layer rather than a
              blur listener, so a tap that dismisses the menu does not also
              activate whatever was underneath it. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => onOpenChange(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className={cn(
              'absolute bottom-full left-0 z-20 mb-sp-2 min-w-60 overflow-hidden',
              'rounded-waiter border border-slate-200 bg-white shadow-el-2',
            )}
          >
            {items.map((item, index) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  onOpenChange(false)
                  item.onClick()
                }}
                className={cn(
                  'flex h-touch-kitchen w-full items-center px-sp-4 text-left text-fs-16 font-semibold',
                  'transition-colors duration-80 ease-standard',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
                  // A destructive item is separated by a rule as well as
                  // coloured, so it is not reached by muscle memory alone.
                  index > 0 && 'border-t border-slate-200',
                  item.danger
                    ? 'text-unavailable-band active:bg-unavailable-body'
                    : 'text-slate-900 active:bg-slate-100',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
