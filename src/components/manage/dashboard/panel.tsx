import type { ReactNode } from 'react'
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
 */
export function Panel({
  title,
  subtitle,
  action,
  minHeight,
  className,
  children,
}: {
  title: string
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
          <h2 className={cn('text-fs-16 font-extrabold', tone.ink)}>{title}</h2>
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
