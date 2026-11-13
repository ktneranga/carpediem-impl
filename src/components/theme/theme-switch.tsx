'use client'

import { useEffect } from 'react'
import { Moon, Sun } from 'lucide-react'
import { setThemeChoice, useTheme } from '@/components/theme/theme'
import { cn } from '@/lib/utils'

/**
 * Keeps <html data-theme> in step with the app-wide choice after the first
 * paint (the root layout's `THEME_SCRIPT` set it before). Mounted once, in the
 * root layout, for every screen — POS and Manage share one look.
 */
export function ThemeRoot() {
  const { dark } = useTheme()
  useEffect(() => {
    const root = document.documentElement
    if (dark) root.dataset.theme = 'night'
    else delete root.dataset.theme
  }, [dark])
  return null
}

/**
 * The Dark mode switch (Teran, 2026-11-13: visible, and a real toggle), in the
 * Manage menu and the POS staff menu — one setting for both. It starts on
 * whatever the device uses; flipping it pins Light or Dark for this browser.
 * `withLabel` shows "Dark mode" beside it; without, it is the bare switch —
 * still named for screen readers.
 */
export function ThemeToggle({ withLabel = false, className }: { withLabel?: boolean; className?: string }) {
  const { dark } = useTheme()
  const flip = () => setThemeChoice(dark ? 'light' : 'dark')

  const knob = (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors',
        dark ? 'border-brand-500 bg-brand-500' : 'border-slate-300 bg-slate-200',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 inline-flex size-[1.375rem] items-center justify-center rounded-full bg-white shadow transition-transform',
          dark ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        )}
      >
        {dark ? <Moon className="size-3.5 text-brand-700" /> : <Sun className="size-3.5 text-amber-500" />}
      </span>
    </span>
  )

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      onClick={flip}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-sp-3 rounded-control',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        withLabel
          ? 'w-full justify-between border border-slate-200 px-sp-3 text-fs-14 font-semibold text-slate-700 hover:bg-slate-50 night:border-night-hairline night:text-night-second night:hover:bg-night-raised'
          : 'px-sp-1',
        className,
      )}
    >
      {withLabel ? (
        <span className="flex items-center gap-sp-2">
          {dark ? <Moon className="size-4" aria-hidden="true" /> : <Sun className="size-4" aria-hidden="true" />}
          Dark mode
        </span>
      ) : null}
      {knob}
    </button>
  )
}
