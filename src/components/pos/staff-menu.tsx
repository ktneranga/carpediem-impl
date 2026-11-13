'use client'

import { useEffect, useState } from 'react'
import { Ban, LogOut, Settings } from 'lucide-react'
import { StaffBadge } from '@/components/pos/staff-badge'
import { cn } from '@/lib/utils'

/**
 * The staff badge in the top-right corner of every screen: a tap opens a small
 * menu instead of signing out at once (Teran, 2026-11-13). Switch user for
 * everyone; Manage above it for the owner (Story 10.0, AC 1); Sold out between
 * them for owner and waiters (Story 8.3).
 *
 * Open state in `useState` and outside-tap detection by `closest()` in an
 * effect — no ref read during render (this repo's React Compiler lint).
 */
export function StaffMenu({
  staffName,
  clock,
  onManage,
  onSoldOut,
  onSwitchUser,
}: {
  staffName: string
  clock: string
  /** Owner only. Absent: the menu offers Switch user alone. */
  onManage?: () => void
  /** Owner and waiters (`canMarkSoldOut`, Story 8.3): Manage → Sold out, no password. */
  onSoldOut?: () => void
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
      <StaffBadge staffName={staffName} clock={clock} menuOpen={open} onTap={() => setOpen((value) => !value)} />
      {open ? (
        <div
          role="menu"
          aria-label="Staff menu"
          className="absolute right-0 top-full z-40 mt-sp-1 w-48 rounded-control border border-slate-200 bg-white p-sp-1 shadow-lg"
        >
          {onManage ? (
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
          ) : null}
          {onSoldOut ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                setOpen(false)
                onSoldOut()
              }}
            >
              <Ban aria-hidden="true" className="size-4 text-slate-600" />
              Sold out
            </button>
          ) : null}
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
