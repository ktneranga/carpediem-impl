'use client'

import { useEffect } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { setThemeChoice, useManageTheme, type ThemeChoice } from '@/components/manage/theme'
import { cn } from '@/lib/utils'

/**
 * Puts the Manage area's light / dark choice on <html> while a Manage screen is
 * open (the layout and the unlock screen render it), and takes it off on the
 * way out, so the POS screens are never touched.
 */
export function ManageThemeRoot() {
  const { dark } = useManageTheme()
  useEffect(() => {
    const root = document.documentElement
    if (dark) root.dataset.theme = 'night'
    else delete root.dataset.theme
    return () => {
      delete root.dataset.theme
    }
  }, [dark])
  return null
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'auto', label: 'Follow device', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

/** One small button that steps Follow device → Light → Dark. A rare choice, so not a big control. */
export function ManageThemeToggle({ className }: { className?: string }) {
  const { choice } = useManageTheme()
  const current = THEMES.find((t) => t.value === choice)!
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!
  const Icon = current.icon
  return (
    <button
      type="button"
      aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      title={`Theme: ${current.label}`}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-slate-600 hover:bg-slate-100',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        'night:text-night-second night:hover:bg-night-raised',
        className,
      )}
      onClick={() => setThemeChoice(next.value)}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  )
}
