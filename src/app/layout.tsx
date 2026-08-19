import type { Metadata } from 'next'
import { headers } from 'next/headers'
import '@fontsource-variable/inter'
import './globals.css'

export const metadata: Metadata = {
  title: 'Carpe Diem RMS',
  description: 'Restaurant management system for Carpe Diem Restaurant',
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const headersList = await headers()
  const role = headersList.get('x-staff-role') as 'waiter' | 'owner' | 'kitchen' | null

  return (
    <html
      lang="en"
      {...(role ? { 'data-context': role } : {})}
      className="antialiased"
    >
      <body className="min-h-full">{children}</body>
    </html>
  )
}
