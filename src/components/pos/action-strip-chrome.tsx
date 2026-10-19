'use client'

import { cn } from '@/lib/utils'

/**
 * Chrome shared by the two bottom action strips.
 *
 * ── Why shared, and why the strips themselves are NOT ────────────────────────
 * `floor-action-strip.tsx` carried a note from Story 3.7 asking whether it and
 * Epic 4's `OrderActionStrip` should converge. They should not: one switches on
 * TABLE state plus merge and seating modes, the other on an order round's
 * lifecycle. A single component would hold two unrelated state machines and
 * every prop of both, and the floor strip already runs five branches before it
 * reaches its default.
 *
 * What they genuinely share is this — the sticky shell, the announced label
 * block, and the two button styles. That was duplicated, and duplicated chrome
 * drifts the first time either strip is touched. Story 4.1 extracted it before
 * the second strip existed to copy it again.
 */

/**
 * The strip shell.
 *
 * `role="region"` with a name, because an action elsewhere on the screen changes
 * this element and nothing else — without a landmark, a screen-reader user hears
 * a card's state flip and has to traverse the rest of the document to discover
 * that the available actions changed. `aria-live="polite"` on the label block
 * announces the change where it happens.
 *
 * `min-h-24` is a floor, not a fixed height — a button row can wrap on a narrow
 * tablet. Nothing reflows underneath regardless, provided the PAGE is a flex
 * column with a `flex-1` main; `sticky bottom-0` alone never pushes the strip to
 * the bottom of a short screen, it only shifts it toward that edge from wherever
 * it already sits. Both `table-grid.tsx` and `order-screen.tsx` do this.
 *
 * ── The full-width `commit` slot was removed on 2026-09-20 ───────────────────
 * It existed for one caller: the order strip's Send, on its own row beneath
 * everything else. Teran's mockup puts Send on the button row with the others,
 * so the slot had no user left. `sendButtonClass` below is what makes it read as
 * the primary action now — width and weight rather than a row of its own.
 */
export function ActionStripShell({
  regionLabel,
  eyebrow,
  label,
  detail,
  muted = false,
  children,
}: {
  /** Names the landmark. "Selected table actions", "Order actions". */
  regionLabel: string
  /** Small caps above the label — what KIND of thing this strip is about. */
  eyebrow: string
  label: string
  detail?: string
  /**
   * A terminal state with nothing to do — a closed session.
   *
   * Greys the shell so it reads as finished rather than merely empty. Paired
   * with rendering NO buttons at all, never disabled ones: a disabled control
   * invites a tap and teaches nothing.
   */
  muted?: boolean
  children?: React.ReactNode
}) {
  return (
    <div
      role="region"
      aria-label={regionLabel}
      className={cn(
        'sticky bottom-0 flex min-h-24 flex-wrap items-center justify-between gap-sp-4',
        'border-t border-slate-200 px-sp-4 py-sp-3 shadow-el-3',
        muted ? 'bg-slate-100' : 'bg-white',
      )}
    >
      <div aria-live="polite" className="flex min-w-0 flex-col gap-sp-1">
        {/* slate-600, not slate-400 (2.56:1): on the order screen this eyebrow says
            "NOT SENT", the one fact that must never be misread. */}
        <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
          {eyebrow}
        </span>
        <span
          className={cn(
            'truncate text-fs-18 font-bold tracking-title',
            muted ? 'text-slate-600' : 'text-slate-900',
          )}
        >
          {label}
        </span>
        {detail ? <span className="truncate text-fs-14 text-slate-600">{detail}</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-sp-3">{children}</div>
    </div>
  )
}

/**
 * The primary action.
 *
 * `h-touch-waiter` is 80px, comfortably over the 56px floor every waiter-context
 * target must clear.
 *
 * ── `brand-700`, changed from `brand-500` on 2026-09-12 ──────────────────────
 * White on `--color-brand-500` (#2288B4) is 3.9:1 at `text-fs-16` bold, which is
 * not large text under WCAG and therefore fails AA — the same trap the `--*-band`
 * tokens exist to avoid, and which this comment previously claimed had been
 * avoided while the class said otherwise.
 *
 * Changing it alters `FloorActionStrip` too, since both strips import this
 * constant, and Story 4.1 Task 1 forbade redesigning that strip. Teran's call:
 * this is a defect fix that happens to be visible, not a redesign. A button
 * nobody can read is not an appearance worth preserving.
 */
export const primaryButtonClass = cn(
  'h-touch-waiter min-w-40 rounded-waiter px-sp-5 text-fs-16 font-bold tracking-title',
  'bg-brand-700 text-white shadow-el-2 inset-shadow-top',
  'transition-[transform,box-shadow] duration-80 ease-standard',
  'active:scale-[0.97] active:bg-brand-500 active:shadow-pressed',
  'disabled:opacity-40 disabled:active:scale-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700',
)

/** The secondary action. Same height, quieter weight. */
export const secondaryButtonClass = cn(
  'h-touch-waiter min-w-32 rounded-waiter px-sp-4 text-fs-16 font-semibold',
  'border border-slate-200 bg-white text-slate-600 shadow-el-1',
  'transition-[transform,box-shadow] duration-80 ease-standard',
  'active:scale-[0.97] active:shadow-pressed',
  'disabled:opacity-40 disabled:active:scale-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
)

/**
 * The full-width commit, for a SHEET rather than a strip.
 *
 * `ux-design-specification.md:899` — "Send Order is always full-width brand-700,
 * the single unmissable primary action." That is still the treatment inside the
 * modifier sheet, whose "Add to Order" spans the sheet. The order STRIP no
 * longer uses it; see `sendButtonClass`.
 */
export const commitButtonClass = cn(
  'h-touch-waiter w-full rounded-waiter px-sp-5 text-fs-18 font-extrabold tracking-title',
  'bg-brand-700 text-white shadow-el-2 inset-shadow-top',
  'transition-[transform,box-shadow] duration-80 ease-standard',
  'active:scale-[0.99] active:shadow-pressed',
  'disabled:opacity-40 disabled:active:scale-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
)

/**
 * Send — the order strip's primary action, on the button row.
 *
 * ── A deliberate divergence from the UX spec, taken 2026-09-20 ───────────────
 * `ux-design-specification.md:899` makes Send full-width on its own row. Teran's
 * mockup puts it on the row with the others, and that is what is built. What the
 * spec was protecting — that the one irreversible action in the order flow is
 * unmissable — is carried by weight instead of by width: it is the widest
 * control on the row (`min-w-64`), the only solid brand fill among them, a size
 * larger, and last in reading order.
 *
 * Still `h-touch-waiter` (80px) though the mockup draws about 56px. Every
 * waiter-context control in this product is 80px; a bar tapped mid-service, at
 * speed, with wet hands is the last place to shave a target.
 *
 * Disabled is `opacity-40` of the solid brand, which lands on the soft blue the
 * mockup shows for "nothing staged yet" — the same state, reached by a rule
 * rather than by a second colour to keep in step.
 */
export const sendButtonClass = cn(
  'h-touch-waiter min-w-64 rounded-waiter px-sp-6 text-fs-18 font-extrabold tracking-title',
  'bg-brand-700 text-white shadow-el-2 inset-shadow-top',
  'transition-[transform,box-shadow] duration-80 ease-standard',
  'active:scale-[0.97] active:bg-brand-500 active:shadow-pressed',
  'disabled:opacity-40 disabled:active:scale-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700',
)
