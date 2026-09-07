'use client'

import { useCallback, useState } from 'react'
import { Delete } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Fixed at 4 (2026-09-06). PINs were 4–6 digits; the range was reduced because
 * staff have to recall these from memory during service, and a longer PIN buys
 * accountability that a forgotten one immediately loses.
 *
 * A single fixed length is what makes auto-submit possible: the pad knows the
 * entry is finished on the fourth digit, so there is no confirm button to tap
 * and nothing to decide. With a range, 4 and 5 digits were indistinguishable
 * from "still typing".
 *
 * The server enforces the same length (src/app/api/auth/login/route.ts). If this
 * ever changes, change both — a client that submits 4 digits to a server
 * expecting 6 fails with a validation error the staff member cannot act on.
 */
const PIN_LENGTH = 4

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export type PINPadProps = {
  /**
   * Receives the entered PIN. Component state is wiped immediately after this
   * returns, so copy the value if you need it beyond the synchronous call.
   * NEVER log the value passed here (NFR-S1).
   */
  onSubmit: (pin: string) => void
  /** Server-side rejection message. Triggers the shake. */
  error?: string | null
  /** Blocks all input, e.g. while an auth request is in flight. */
  disabled?: boolean
  /** Context label — "Confirm your PIN" for financial reauth, staff name for a user switch. */
  label?: string
  /** Sub-label under the title. The sign-in screen states why it is being seen again. */
  hint?: string
}

export function PINPad({ onSubmit, error, disabled = false, label, hint }: PINPadProps) {
  const [pin, setPin] = useState('')
  // Hides the parent's error once the staff member starts a fresh attempt.
  const [errorDismissed, setErrorDismissed] = useState(false)
  // Changes on every new parent error so the shake replays rather than sitting
  // inert — a CSS animation does not restart while its class stays applied.
  const [errorNonce, setErrorNonce] = useState(0)
  const [prevError, setPrevError] = useState(error)

  // Adjusting state during render is React's documented pattern for reacting to
  // a changed prop. An effect would work too but fires after paint — the shake
  // would visibly lag the error — and trips `react-hooks/set-state-in-effect`.
  if (error !== prevError) {
    setPrevError(error)
    setErrorDismissed(false)
    setErrorNonce((n) => n + 1)
  }

  // Only the server can reject a PIN now. There is no local validation left:
  // a too-short PIN is unreachable, because the pad submits the moment the
  // fourth digit lands and cannot hold a fifth.
  const visibleError = errorDismissed ? null : error

  const submit = useCallback(
    (value: string) => {
      // Wipe before invoking so the value cannot linger if the callback throws.
      setPin('')
      onSubmit(value)
    },
    [onSubmit],
  )

  const clearErrors = useCallback(() => {
    setErrorDismissed(true)
  }, [])

  const handleDigit = useCallback(
    (digit: string) => {
      if (disabled || pin.length >= PIN_LENGTH) return

      clearErrors()
      const next = pin + digit
      setPin(next)

      // Auto-submit on the final digit. Computed from the closure value and
      // called directly — NOT from inside a setState updater. React may invoke an
      // updater twice under Strict Mode, which would submit the credential twice.
      if (next.length === PIN_LENGTH) {
        submit(next)
      }
    },
    [disabled, pin, clearErrors, submit],
  )

  const handleClear = useCallback(() => {
    if (disabled) return
    clearErrors()
    setPin('')
  }, [disabled, clearErrors])

  const handleBackspace = useCallback(() => {
    if (disabled) return
    clearErrors()
    setPin((current) => current.slice(0, -1))
  }, [disabled, clearErrors])

  // 96px keys. Press is scale 0.97 plus a 6% darken and a drop to the pressed
  // shadow — never a colour change, which reads as a state rather than a touch.
  const keyClasses = cn(
    'size-24 rounded-waiter border border-slate-200 bg-white shadow-el-1',
    'text-fs-24 font-bold text-slate-900 tabular-nums leading-none',
    'transition-[transform,box-shadow,background-color] duration-80 ease-standard',
    'active:scale-[0.97] active:bg-slate-100 active:shadow-pressed',
    'disabled:opacity-40 disabled:active:scale-100 disabled:active:bg-white',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  /** Clear and backspace are recessive: they sit on the app ground, not a card. */
  const utilityKeyClasses = cn(
    keyClasses,
    'bg-slate-100 text-fs-12 font-semibold tracking-micro text-slate-600 uppercase shadow-none',
  )

  return (
    <div className="flex select-none flex-col items-center gap-sp-5">
      {label ? (
        <div className="flex flex-col items-center gap-sp-1">
          <p className="text-fs-18 font-bold tracking-title text-slate-900">{label}</p>
          {hint ? <p className="text-fs-12 text-slate-400">{hint}</p> : null}
        </div>
      ) : null}

      {/* `key` forces a remount on each new error so the shake actually replays. */}
      <div
        key={errorNonce}
        className={cn('flex flex-col items-center gap-sp-2', visibleError && 'animate-shake')}
      >
        {/* Dots are decorative — the live region carries the meaning, so a screen
            reader announces a count rather than four bullet glyphs. Digits are
            never rendered anywhere in the DOM.

            Four dots is also the only progress cue a staff member needs now:
            the pad submits when the last one fills, so the dots show exactly how
            far along they are with no ambiguity about when it ends. */}
        <div aria-live="polite" className="flex flex-col items-center gap-sp-2">
          <div aria-hidden="true" className="flex gap-sp-3">
            {Array.from({ length: PIN_LENGTH }, (_, index) => (
              <span
                key={index}
                className={cn(
                  'size-3.5 rounded-pill border-2 transition-colors duration-80 ease-standard',
                  index < pin.length
                    ? 'border-brand-500 bg-brand-500'
                    : 'border-slate-200 bg-transparent',
                )}
              />
            ))}
          </div>
          <span className="sr-only">{`${pin.length} digits entered`}</span>
        </div>

        {/* Sibling of the polite region, not nested inside it — role="alert" is
            itself a live region, and nesting them causes duplicate or dropped
            announcements. Height is reserved so the pad never shifts. */}
        <p
          role="alert"
          className={cn(
            'min-h-5 text-fs-12 font-semibold',
            visibleError ? 'text-unavailable-ink' : 'text-transparent',
          )}
        >
          {visibleError ?? ' '}
        </p>
      </div>

      {/* Digits are captured only through buttons. No <input> anywhere — even a
          readOnly one can summon the virtual keyboard on some Android builds
          and shift the layout out from under the pad. */}
      <div className="grid grid-cols-3 gap-sp-3">
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled}
            aria-label={`Enter digit ${digit}`}
            onClick={() => handleDigit(digit)}
            className={keyClasses}
          >
            {digit}
          </button>
        ))}

        <button
          type="button"
          disabled={disabled}
          aria-label="Clear all digits"
          onClick={handleClear}
          className={utilityKeyClasses}
        >
          Clr
        </button>

        <button
          type="button"
          disabled={disabled}
          aria-label="Enter digit 0"
          onClick={() => handleDigit('0')}
          className={keyClasses}
        >
          0
        </button>

        <button
          type="button"
          disabled={disabled}
          aria-label="Delete last digit"
          onClick={handleBackspace}
          className={cn(utilityKeyClasses, 'flex items-center justify-center')}
        >
          <Delete aria-hidden="true" className="size-6" strokeWidth={2} />
        </button>
      </div>

      {/*
        No confirm button, by design.

        The system rule is "auto-submit on the last digit — no confirm button",
        which only works when every PIN is the same length. It now is: PIN_LENGTH
        is fixed at 4, so the fourth digit unambiguously ends the entry. A Sign in
        button here could never be in a valid state — below four digits it would
        have to refuse, and at four the pad has already submitted — so it would
        be a dead control on the one screen every shift starts with.

        The previous version of this file said to remove it the day PIN length
        became fixed. That day is today.
      */}

      <p className="text-fs-12 text-slate-400">
        {PIN_LENGTH} digits · signs in automatically · no keyboard, ever
      </p>
    </div>
  )
}
