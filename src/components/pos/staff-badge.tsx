'use client'

import { useToday } from '@/hooks/use-clock'
import { cn } from '@/lib/utils'

/**
 * Who is signed in, and the time. The same control on every screen that has one.
 *
 * ── Why a component and not two copies ───────────────────────────────────────
 * This is the only thing on the floor header and the order header that is
 * genuinely the SAME thing: not a table, not an order, just "you are Nina and
 * it is 12:46, tap to hand the tablet over". The two headers around it differ
 * because the screens differ, but this does not, and a second copy would drift
 * the first time one of them was measured against a design and the other was
 * not — which is exactly how the order screen ended up with a bordered white
 * pill while the floor had the filled circle.
 *
 * ── The initial, not a photo ─────────────────────────────────────────────────
 * There are no staff avatars in this system and there is no plan for any. The
 * circle is a letter on brand-800, which is recognisable at arm's length on a
 * glary beach tablet and costs no upload, no storage and no moderation.
 *
 * 40px, measured off the design. The button around it is the 44px standard
 * touch floor: switching user is a rare, deliberate tap, not something hit
 * mid-service like Back or Send.
 */
export function StaffBadge({
  staffName,
  clock,
  onTap,
  menuOpen,
}: {
  staffName: string
  /** Whether the staff menu this badge opens is showing (for screen readers). */
  menuOpen: boolean
  /** Wall clock, "12:46". Passed in so the whole screen ticks together. */
  clock: string
  onTap: () => void
}) {
  // '?' rather than an empty circle: a nameless staff row is a data fault, and
  // a blank disc looks like a loading state that will never finish.
  const initial = staffName.trim().charAt(0).toUpperCase() || '?'
  // The date beside the time on every screen (Teran, 2026-11-02). Read here
  // rather than passed in: unlike the clock, no screen ticks anything off it.
  const today = useToday()

  return (
    <button
      type="button"
      onClick={onTap}
      // Names, not roles. Accountability is a design feature.
      aria-label={`Signed in as ${staffName}. Staff menu.`}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      className={cn(
        'flex min-h-touch-standard shrink-0 items-center gap-sp-2 rounded-control px-sp-2',
        'transition-transform duration-80 ease-standard active:scale-[0.97]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-pill',
          'bg-brand-800 text-fs-14 font-extrabold text-white',
        )}
      >
        {initial}
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span className="text-fs-14 font-bold text-slate-900 night:text-night-text">{staffName}</span>
        {/* Empty during SSR and hydration, filled immediately after — see
            `useClock`. No suppressHydrationWarning needed. */}
        <span className="text-fs-12 tabular-nums text-slate-600 night:text-night-second">
          {today && clock ? `${today} · ${clock}` : clock}
        </span>
      </span>
    </button>
  )
}
