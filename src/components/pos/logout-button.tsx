'use client'

import { useState } from 'react'

export function LogoutButton() {
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function handleLogout() {
    setIsSigningOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      // Full navigation rather than router.push — the root layout derives
      // [data-context] server-side, so the server must re-render.
      window.location.assign('/login')
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={isSigningOut}
      className="h-space-12 rounded-2xl border border-neutral-200 bg-neutral-0 px-space-6 text-h2 font-medium text-neutral-600 transition-colors active:bg-neutral-100 disabled:opacity-40"
    >
      {isSigningOut ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
