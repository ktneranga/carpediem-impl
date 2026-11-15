'use client'

import { useState, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A password or PIN field with a Show/Hide eye inside its right edge (Teran,
 * 2026-11-15: every password entry lets you check what you typed). Not used on
 * the login PIN pad, where digits on screen would be seen by the people around.
 *
 * Takes every `<input>` prop; `className` styles the input itself, so callers
 * pass the same class they used before. `what` names it for screen readers.
 */
export function PasswordInput({
  className,
  what = 'password',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { what?: 'password' | 'PIN' }) {
  const [shown, setShown] = useState(false)
  return (
    <span className="relative flex min-w-0">
      <input {...props} type={shown ? 'text' : 'password'} className={cn(className, 'w-full min-w-0 pr-12')} />
      <button
        type="button"
        aria-label={shown ? `Hide ${what}` : `Show ${what}`}
        aria-pressed={shown}
        onClick={() => setShown((current) => !current)}
        className={cn(
          'absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-control text-slate-500 hover:text-slate-800',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500',
          'night:text-night-muted night:hover:text-night-text',
        )}
      >
        {shown ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
      </button>
    </span>
  )
}
