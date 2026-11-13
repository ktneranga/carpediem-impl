'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Lock } from 'lucide-react'
import { MANAGE_SECTIONS } from './sections'
import { cn } from '@/lib/utils'

const itemClass = cn(
  'flex min-h-touch-standard items-center rounded-control px-sp-3 text-fs-14 font-semibold whitespace-nowrap',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
)

export function ManageNav() {
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
    <aside className="flex shrink-0 flex-col gap-sp-2 border-b border-slate-200 bg-white p-sp-3 md:w-60 md:border-r md:border-b-0 md:p-sp-4">
      <p className="hidden px-sp-3 pb-sp-2 text-fs-18 font-extrabold text-slate-900 md:block">Manage</p>

      <nav aria-label="Manage sections" className="overflow-x-auto">
        <ul className="flex gap-sp-1 md:flex-col">
          {MANAGE_SECTIONS.map((section) => {
            const current = pathname === section.href || pathname.startsWith(`${section.href}/`)
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    itemClass,
                    current ? 'bg-brand-050 text-brand-800' : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  {section.title}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="flex gap-sp-1 md:mt-auto md:flex-col">
        <Link href="/" className={cn(itemClass, 'gap-sp-2 text-slate-600 hover:bg-slate-100')}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to floor
        </Link>
        <button
          type="button"
          onClick={lock}
          disabled={locking}
          className={cn(itemClass, 'gap-sp-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50')}
        >
          <Lock aria-hidden="true" className="size-4" />
          Lock
        </button>
      </div>
    </aside>
  )
}
