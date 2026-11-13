'use client'

import { useSyncExternalStore } from 'react'
import { OLD_THEME_KEY as OLD_KEY, THEME_KEY } from '@/components/theme/theme-script'

/**
 * Light / dark for the WHOLE app — POS and Manage alike (Teran, 2026-11-13: one
 * setting, so moving between the floor and Manage never changes the look).
 *
 * `auto` (nothing stored) follows the device. The Dark mode switch stores
 * `light` or `dark` for this browser (localStorage) — a per-device convenience;
 * if storage is blocked the app simply follows the device. Another tab of the
 * same browser follows a change at once (`storage` event).
 *
 * Dark uses the design system's night tokens (`night:` variant,
 * `[data-theme="night"]` on <html>, globals.css). `THEME_SCRIPT` (theme-script.ts) sets that
 * attribute before the first paint; `ThemeRoot` keeps it in step afterwards.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark'

const listeners = new Set<() => void>()
let current: ThemeChoice | null = null

function readChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_KEY) ?? window.localStorage.getItem(OLD_KEY)
    return value === 'light' || value === 'dark' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'auto') window.localStorage.removeItem(THEME_KEY)
    else window.localStorage.setItem(THEME_KEY, choice)
    window.localStorage.removeItem(OLD_KEY)
  } catch {
    // Not saved; it still applies until the page is left.
  }
  current = choice
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) {
      current = readChoice()
      listener()
    }
  }
  media.addEventListener('change', listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    media.removeEventListener('change', listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** `choice|resolved`, so one snapshot string carries both. */
function snapshot(): string {
  current ??= readChoice()
  const dark = current === 'dark' || (current === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return `${current}|${dark ? 'dark' : 'light'}`
}

export function useTheme(): { choice: ThemeChoice; dark: boolean } {
  const value = useSyncExternalStore(subscribe, snapshot, () => 'auto|light')
  const [choice, resolved] = value.split('|') as [ThemeChoice, string]
  return { choice, dark: resolved === 'dark' }
}
