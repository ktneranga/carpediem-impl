'use client'

import { useEffect } from 'react'
import { Moon, Sun } from 'lucide-react'
import { setThemeChoice, useManageTheme } from '@/components/manage/theme'
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

/**
 * The Dark mode switch (Teran, 2026-11-13: visible, and a real toggle). It
 * starts on whatever the device uses; flipping it pins Light or Dark for this
 * browser. `withLabel` shows "Dark mode" beside it (the laptop menu); without,
 * it is the bare switch (the phone's top row) — still named for screen readers.
 */
export function ManageThemeToggle({ withLabel = false, className }: { withLabel?: boolean; className?: string }) {
  const { dark } = useManageTheme()
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
