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
 */
export function ActionStripShell({
  regionLabel,
  eyebrow,
  label,
  detail,
  muted = false,
  commit,
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
  /**
   * The full-width commit, rendered on its own row beneath everything else.
   *
   * A SLOT rather than just another child, because `w-full` on a child of the
   * button row resolves to 100% of that row — which is `flex: 0 1 auto` in a
   * `justify-between` container, so its used width is max-content. "Submit
   * Order" therefore wrapped onto its own line and rendered about 300px wide,
   * right-aligned, while both its own docstring and the branch that rendered it
   * claimed it spanned the strip. Being a direct flex item of the shell with
   * `w-full` is what actually makes it full-width.
   */
  commit?: React.ReactNode
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
        <span className="text-fs-12 font-semibold tracking-micro text-slate-400 uppercase">
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

      {commit ? <div className="w-full">{commit}</div> : null}
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
 * The full-width commit.
 *
 * `ux-design-specification.md:899` — "Send Order is always full-width brand-700,
 * the single unmissable primary action." (The spec's label is "Send Order";
 * Story 4.1 Decision 2 keeps the epics' "Submit Order", which four later stories
 * reference by name. The full-width rule is what is being honoured here.) It is
 * the ONLY control in the system
 * that takes the whole strip width; everything else sits in the right-hand row.
 * Reserved for submitting a round to production, which is the one action in the
 * order flow that reaches the kitchen and cannot be quietly taken back.
 */
export const commitButtonClass = cn(
  'h-touch-waiter w-full rounded-waiter px-sp-5 text-fs-18 font-extrabold tracking-title',
  'bg-brand-700 text-white shadow-el-2 inset-shadow-top',
  'transition-[transform,box-shadow] duration-80 ease-standard',
  'active:scale-[0.99] active:shadow-pressed',
  'disabled:opacity-40 disabled:active:scale-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
)
