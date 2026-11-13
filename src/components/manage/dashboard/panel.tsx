import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A dashboard card (Story 9.1). `minHeight` is the card's final height class,
 * so the skeleton and the loaded card take the same room and nothing jumps.
 */
export function Panel({
  title,
  action,
  minHeight,
  className,
  children,
}: {
  title: string
  action?: ReactNode
  minHeight: string
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className={cn('flex flex-col gap-sp-3 rounded-panel bg-white p-sp-4', minHeight, className)}>
      <div className="flex min-h-8 items-center justify-between gap-sp-3">
        <h2 className="text-fs-14 font-bold tracking-micro text-slate-500 uppercase">{title}</h2>
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
        <div key={index} className={cn('h-5 rounded-control bg-slate-100', index === 0 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}
