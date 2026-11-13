'use client'

import { useSyncExternalStore } from 'react'

/**
 * The Manage area's light / dark choice (Teran, 2026-11-13). `auto` follows
 * the device. Kept in this browser only (localStorage) — a per-viewer
 * convenience; if storage is blocked Manage simply follows the device.
 *
 * Dark uses the design system's night tokens (`night:` variant,
 * `[data-theme="night"]`, globals.css). `ManageThemeRoot` puts the attribute
 * on <html> while a Manage screen is open; the POS never gets it.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark'
const KEY = 'cdrms-manage-theme'
const listeners = new Set<() => void>()

function readChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'auto') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, choice)
  } catch {
    // Not saved; it still applies until the page is left.
  }
  current = choice
  for (const listener of listeners) listener()
}

let current: ThemeChoice | null = null

function subscribe(listener: () => void) {
  listeners.add(listener)
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', listener)
  return () => {
    listeners.delete(listener)
    media.removeEventListener('change', listener)
  }
}

/** `choice|resolved`, so one snapshot string carries both. */
function snapshot(): string {
  current ??= readChoice()
  const dark = current === 'dark' || (current === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return `${current}|${dark ? 'dark' : 'light'}`
}

export function useManageTheme(): { choice: ThemeChoice; dark: boolean } {
  const value = useSyncExternalStore(subscribe, snapshot, () => 'auto|light')
  const [choice, resolved] = value.split('|') as [ThemeChoice, string]
  return { choice, dark: resolved === 'dark' }
}
