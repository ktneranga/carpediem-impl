'use client'

import { useEffect, useState } from 'react'
import { LogOut, Settings } from 'lucide-react'
import { StaffBadge } from '@/components/pos/staff-badge'
import { cn } from '@/lib/utils'

/**
 * The owner's badge: a tap opens a small menu — Manage, Switch user (Story
 * 10.0, AC 1). Everyone else's badge still switches user at once; that is
 * `StaffBadge` on its own, unchanged.
 *
 * Open state in `useState` and outside-tap detection by `closest()` in an
 * effect — no ref read during render (this repo's React Compiler lint).
 */
export function StaffMenu({
  staffName,
  clock,
  onManage,
  onSwitchUser,
}: {
  staffName: string
  clock: string
  onManage: () => void
  onSwitchUser: () => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-staff-menu]')) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const itemClass = cn(
    'flex min-h-touch-standard w-full items-center gap-sp-2 rounded-control px-sp-3',
    'text-left text-fs-14 font-semibold text-slate-900 hover:bg-slate-100',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    <div data-staff-menu className="relative">
      <StaffBadge staffName={staffName} clock={clock} onTap={() => setOpen((value) => !value)} />
      {open ? (
        <div
          role="menu"
          aria-label="Staff menu"
          className="absolute right-0 top-full z-40 mt-sp-1 w-48 rounded-control border border-slate-200 bg-white p-sp-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false)
              onManage()
            }}
          >
            <Settings aria-hidden="true" className="size-4 text-slate-600" />
            Manage
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false)
              onSwitchUser()
            }}
          >
            <LogOut aria-hidden="true" className="size-4 text-slate-600" />
            Switch user
          </button>
        </div>
      ) : null}
    </div>
  )
}
