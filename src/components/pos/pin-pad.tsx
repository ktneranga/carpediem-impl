'use client'

import { useCallback, useState } from 'react'
import { Delete } from 'lucide-react'
import { cn } from '@/lib/utils'

const MIN_PIN_LENGTH = 4
const MAX_PIN_LENGTH = 6
const SHORT_PIN_ERROR = `PIN must be at least ${MIN_PIN_LENGTH} digits`

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const

export type PINPadProps = {
  /**
   * Receives the entered PIN. Component state is wiped immediately after this
   * returns, so copy the value if you need it beyond the synchronous call.
   * NEVER log the value passed here (NFR-S1).
   */
  onSubmit: (pin: string) => void
  /** Server-side rejection message, e.g. "Incorrect PIN". Triggers the shake. */
  error?: string | null
  /** Blocks all input, e.g. while an auth request is in flight. */
  disabled?: boolean
  /** Context label — "Confirm your PIN" for financial reauth, staff name for a user switch. */
  label?: string
}

export function PINPad({ onSubmit, error, disabled = false, label }: PINPadProps) {
  const [pin, setPin] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
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

  // A server rejection outranks local validation.
  const visibleError = (errorDismissed ? null : error) ?? localError

  const submit = useCallback(
    (value: string) => {
      // Wipe before invoking so the value cannot linger if the callback throws (AC-6).
      setPin('')
      setLocalError(null)
      onSubmit(value)
    },
    [onSubmit],
  )

  const clearErrors = useCallback(() => {
    setLocalError(null)
    setErrorDismissed(true)
  }, [])

  const handleDigit = useCallback(
    (digit: string) => {
      if (disabled || pin.length >= MAX_PIN_LENGTH) return

      clearErrors()
      const next = pin + digit
      setPin(next)

      // Auto-submit on the 6th digit (AC-8). Computed from the closure value and
      // called directly — NOT from inside a setState updater. React may invoke an
      // updater twice under Strict Mode, which would submit the credential twice.
      if (next.length === MAX_PIN_LENGTH) {
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

  const handleSubmit = useCallback(() => {
    if (disabled) return

    if (pin.length < MIN_PIN_LENGTH) {
      setLocalError(SHORT_PIN_ERROR)
      setErrorDismissed(true)
      return
    }

    submit(pin)
  }, [disabled, pin, submit])

  const keyClasses = cn(
    'size-20 rounded-2xl text-h1 font-semibold leading-none',
    'bg-neutral-0 text-neutral-900 border border-neutral-200',
    'transition-colors active:bg-brand-100',
    'disabled:opacity-40 disabled:active:bg-neutral-0',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
  )

  return (
    <div className="flex select-none flex-col items-center gap-space-6">
      {label ? <p className="text-h2 font-medium text-neutral-900">{label}</p> : null}

      {/* `key` forces a remount on each new error so the shake actually replays. */}
      <div
        key={errorNonce}
        className={cn('flex flex-col items-center gap-space-2', visibleError && 'animate-shake')}
      >
        {/* Dots are decorative — the live region carries the meaning, so a screen
            reader announces a count rather than six bullet glyphs. Digits are
            never rendered anywhere in the DOM (AC-10). */}
        <div aria-live="polite" className="flex flex-col items-center gap-space-2">
          <div aria-hidden="true" className="flex gap-space-3">
            {Array.from({ length: MAX_PIN_LENGTH }, (_, index) => (
              <span
                key={index}
                className={cn(
                  'size-4 rounded-full border-2 transition-colors',
                  index < pin.length
                    ? 'border-brand-600 bg-brand-600'
                    : 'border-neutral-400 bg-transparent',
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
            'min-h-[1.25rem] text-small',
            visibleError ? 'text-status-alert' : 'text-transparent',
          )}
        >
          {visibleError ?? ' '}
        </p>
      </div>

      {/* Digits are captured only through buttons. No <input> anywhere — even a
          readOnly one can summon the virtual keyboard on some Android builds
          and shift the layout out from under the pad (AC-2). */}
      <div className="flex flex-col gap-space-3">
        {DIGIT_ROWS.map((row) => (
          <div key={row.join('')} className="flex gap-space-3">
            {row.map((digit) => (
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
          </div>
        ))}

        <div className="flex gap-space-3">
          <button
            type="button"
            disabled={disabled}
            aria-label="Clear all digits"
            onClick={handleClear}
            className={cn(keyClasses, 'text-small font-medium text-neutral-600')}
          >
            Clear
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
            className={cn(keyClasses, 'flex items-center justify-center text-neutral-600')}
          >
            <Delete aria-hidden="true" className="size-7" />
          </button>
        </div>
      </div>

      {/* Submit still exists despite auto-submit: 4- and 5-digit PINs never reach
          the auto-submit threshold and would otherwise be unsubmittable. */}
      <button
        type="button"
        disabled={disabled}
        aria-label="Submit PIN"
        onClick={handleSubmit}
        className={cn(
          'h-space-12 w-full rounded-2xl text-h2 font-semibold',
          'bg-brand-600 text-neutral-0',
          'transition-colors active:bg-brand-700',
          'disabled:opacity-40 disabled:active:bg-brand-600',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700',
        )}
      >
        Submit
      </button>
    </div>
  )
}
