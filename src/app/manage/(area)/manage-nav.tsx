'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Lock, LockKeyhole } from 'lucide-react'
import { MANAGE_SECTIONS } from './sections'
import { ManageThemeToggle } from '@/components/manage/theme-root'
import { cn } from '@/lib/utils'

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
export function ManageNav({ owner, unlocked }: { owner: boolean; unlocked: boolean }) {
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
        {/* On a phone the menu is a top row: light / dark sits here. */}
        <ManageThemeToggle className="md:hidden" />
      </div>

      <div className="hidden items-center justify-between md:flex md:pt-sp-1">
        <p className="px-sp-3 text-fs-18 font-extrabold text-slate-900 night:text-night-text">Manage</p>
        {/* Light / dark for the whole Manage area — small: it is set once and left. */}
        <ManageThemeToggle />
      </div>

      <nav aria-label="Manage sections" className="overflow-x-auto">
        <ul className="flex gap-sp-1 md:flex-col">
          {MANAGE_SECTIONS.filter((section) => unlocked || ('waiter' in section && section.waiter)).map((section) => {
            const current = pathname === section.href || pathname.startsWith(`${section.href}/`)
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    itemClass,
                    current
                      ? 'bg-brand-050 text-brand-800 night:bg-night-raised night:text-night-text'
                      : 'text-slate-600 hover:bg-slate-100 night:text-night-second night:hover:bg-night-raised',
                  )}
                >
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
