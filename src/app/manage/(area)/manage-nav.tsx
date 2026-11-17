'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  ArrowLeft,
  Ban,
  BookOpen,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  LockKeyhole,
  ReceiptText,
  ScrollText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { MANAGE_SECTIONS } from './sections'
import { ThemeToggle } from '@/components/theme/theme-switch'
import { cn } from '@/lib/utils'

/** One icon per section, so the menu scans by shape (Teran, 2026-11-14). */
const SECTION_ICONS: Record<string, LucideIcon> = {
  '/manage/dashboard': LayoutDashboard,
  '/manage/menu': BookOpen,
  '/manage/floor': LayoutGrid,
  '/manage/sold-out': Ban,
  '/manage/staff': Users,
  '/manage/settings': Settings,
  '/manage/audit': ScrollText,
  '/manage/orders': ReceiptText,
}

const itemClass = cn(
  'flex min-h-touch-standard items-center rounded-control px-sp-3 text-fs-14 font-semibold whitespace-nowrap',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
)

/**
 * `unlocked` (owner with a live Manage session): every section, and Lock.
 * Otherwise — a waiter, or the owner on Availability without the password
 * (Story 8.3) — only the sections marked `waiter`; the owner also gets
 * "Open Manage", which asks for the password (Teran, 2026-11-13).
 */
export function ManageNav({
  owner,
  unlocked,
  grantedAreas = [],
  vendorLastUsed,
}: {
  owner: boolean
  unlocked: boolean
  /** A non-owner's granted Manage areas (Story 10.6), as section hrefs. */
  grantedAreas?: string[]
  /** "signed in 14 Nov, 21:30 · last export 14 Nov, 21:31", or "never"; undefined = not shown. */
  vendorLastUsed?: string
}) {
  const pathname = usePathname()
  const [locking, setLocking] = useState(false)

  async function lock() {
    setLocking(true)
    try {
      await fetch('/api/manage/lock', { method: 'POST' })
    } finally {
      // Full navigation: nothing of the area should stay in the client cache.
      window.location.assign('/')
    }
  }

  return (
    <aside className="flex shrink-0 flex-col gap-sp-2 border-b border-slate-200 bg-white p-sp-3 night:border-night-hairline night:bg-night-card md:w-60 md:border-r md:border-b-0 md:p-sp-4">
      {/* At the top, where people look for a way back (Teran, 2026-11-13). */}
      <div className="flex gap-sp-2">
        <Link
          href="/"
          className={cn(itemClass, 'flex-1 gap-sp-2 border border-slate-300 text-slate-900 hover:bg-slate-100 night:border-night-hairline night:text-night-text night:hover:bg-night-raised')}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to floor
        </Link>
        {/* On a phone the menu is a top row: the Dark mode switch sits beside the way back. */}
        <ThemeToggle className="md:hidden" />
      </div>

      {/* Laptop: its own labelled row under the way back, where it is seen (Teran, 2026-11-13). */}
      <ThemeToggle withLabel className="hidden md:inline-flex" />

      <p className="hidden px-sp-3 pt-sp-2 text-fs-18 font-extrabold text-slate-900 night:text-night-text md:block">Manage</p>

      <nav aria-label="Manage sections" className="overflow-x-auto">
        <ul className="flex gap-sp-1 md:flex-col">
          {MANAGE_SECTIONS.filter(
            (section) => unlocked || ('waiter' in section && section.waiter) || grantedAreas.includes(section.href),
          ).map((section) => {
            const current = pathname === section.href || pathname.startsWith(`${section.href}/`)
            const Icon = SECTION_ICONS[section.href]
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    itemClass,
                    'gap-sp-2',
                    current
                      ? 'bg-brand-050 text-brand-800 night:bg-night-raised night:text-night-text'
                      : 'text-slate-600 hover:bg-slate-100 night:text-night-second night:hover:bg-night-raised',
                  )}
                >
                  {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
                  {section.title}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {owner && !unlocked ? (
        <Link
          href="/manage/dashboard"
          className={cn(itemClass, 'gap-sp-2 text-slate-600 hover:bg-slate-100 night:text-night-second night:hover:bg-night-raised')}
        >
          <LockKeyhole aria-hidden="true" className="size-4" />
          Open Manage
        </Link>
      ) : null}

      {unlocked ? (
        <div className="flex gap-sp-1 md:mt-auto md:flex-col">
          {vendorLastUsed !== undefined ? (
            // Small and muted: the owner should be able to see it, not act on it.
            <p className="hidden px-sp-3 text-fs-12 text-slate-500 md:block night:text-night-muted">
              Vendor access: {vendorLastUsed}
            </p>
          ) : null}
          <button
            type="button"
            onClick={lock}
            disabled={locking}
            className={cn(itemClass, 'gap-sp-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50 night:text-night-second night:hover:bg-night-raised')}
          >
            <Lock aria-hidden="true" className="size-4" />
            Lock
          </button>
        </div>
      ) : null}
    </aside>
  )
}

