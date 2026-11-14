'use client'

import { useState, type ReactNode } from 'react'
import { X, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Text and surface classes for the dashboard, light and dark (`night:` — the
 * design system's night tokens, active under `[data-theme="night"]`). Text
 * wears these, never a chart colour.
 */
export const tone = {
  app: 'bg-slate-100 night:bg-night-app',
  card: 'bg-white night:bg-night-card',
  raised: 'bg-slate-100 night:bg-night-raised',
  ink: 'text-slate-900 night:text-night-text',
  second: 'text-slate-600 night:text-night-second',
  muted: 'text-slate-500 night:text-night-muted',
  hairline: 'border-slate-100 night:border-night-hairline',
  good: 'text-open-ink night:text-green-400',
  bad: 'text-red-700 night:text-red-400',
  track: 'bg-slate-100 night:bg-night-sunken',
}

/**
 * A dashboard card (Story 9.1). `minHeight` is the card's final height class,
 * so the skeleton and the loaded card take the same room and nothing jumps.
 * `icon`: one small muted Lucide icon before the title, so cards scan by shape.
 */
export function Panel({
  title,
  icon: Icon,
  subtitle,
  action,
  minHeight,
  className,
  children,
}: {
  title: string
  icon?: LucideIcon
  subtitle?: ReactNode
  action?: ReactNode
  minHeight: string
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className={cn('flex flex-col gap-sp-3 rounded-panel p-sp-4', tone.card, minHeight, className)}>
      <div className="flex min-h-8 flex-wrap items-start justify-between gap-sp-2">
        <div>
          <h2 className={cn('flex items-center gap-sp-2 text-fs-16 font-extrabold', tone.ink)}>
            {Icon ? <Icon className={cn('size-4 shrink-0', tone.muted)} aria-hidden="true" /> : null}
            {title}
          </h2>
          {subtitle ? <p className={cn('text-fs-12', tone.muted)}>{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Grey bars where the content will be, while it loads. */
export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-1 animate-pulse flex-col gap-sp-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={cn('h-5 rounded-control', tone.raised, index === 0 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

/** A small uppercase badge: UNCLOSED, CORRECTION, PEAK 19:00. */
export function Badge({ children, kind }: { children: ReactNode; kind: 'bad' | 'warn' | 'info' }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-sp-1 rounded-pill border px-sp-2 py-0.5 text-fs-12 font-bold tracking-micro uppercase',
        kind === 'bad' && 'border-red-300 bg-red-50 text-red-800 night:border-red-500/40 night:bg-red-500/10 night:text-red-300',
        kind === 'warn' && 'border-amber-300 bg-amber-50 text-amber-900 night:border-amber-500/40 night:bg-amber-500/10 night:text-amber-300',
        kind === 'info' && 'border-slate-200 bg-slate-50 text-slate-700 night:border-night-hairline night:bg-night-raised night:text-night-second',
      )}
    >
      {children}
    </span>
  )
}

/**
 * "Show all (N)" under a list the card cuts short, opening the whole list in a
 * sheet over the dashboard. Renders nothing when everything already fits — a
 * button that reveals nothing new is clutter.
 */
export function ShowAll({ title, total, shown, children }: { title: string; total: number; shown: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (total <= shown) return null
  return (
    <>
      <button
        type="button"
        className="mt-auto inline-flex h-10 items-center self-start rounded-control px-sp-2 text-fs-14 font-bold text-brand-700 hover:bg-slate-100 night:text-brand-300 night:hover:bg-night-raised"
        onClick={() => setOpen(true)}
      >
        Show all ({total})
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
          onClick={(event) => event.target === event.currentTarget && setOpen(false)}
          onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
        >
          <div className={cn('flex max-h-[85vh] w-full max-w-lg flex-col rounded-panel shadow-el-2', tone.card)}>
            <div className="flex items-center justify-between gap-sp-3 p-sp-4 pb-sp-2">
              <h2 className={cn('text-fs-20 font-extrabold', tone.ink)}>{title}</h2>
              <button
                type="button"
                autoFocus
                aria-label="Close"
                className={cn('inline-flex size-11 items-center justify-center rounded-control', tone.second)}
                onClick={() => setOpen(false)}
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <div className="overflow-y-auto px-sp-4 pb-sp-4">{children}</div>
          </div>
        </div>
      ) : null}
    </>
  )
}
