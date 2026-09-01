'use client'

/**
 * TEMPORARY verification scaffold for Story 3.1.
 *
 * No test framework exists, so the three navigation components are exercised
 * here by hand. Story 3.2 replaces this with the real zone-filtered table grid
 * backed by the database — DELETE this route then, as /pin-demo was deleted in
 * Story 2.2.
 *
 * All data below is hardcoded. These components are presentational by design.
 */

import { useMemo, useState } from 'react'
import { ContextHeader } from '@/components/pos/context-header'
import { TableCard, type TableStatus } from '@/components/pos/table-card'
import { ZoneChipBar, type Zone } from '@/components/pos/zone-chip-bar'

const ZONES: Zone[] = [
  { id: 'z1', name: 'Bean Bags' },
  { id: 'z2', name: 'Sun Beds' },
  { id: 'z3', name: 'Tables' },
  { id: 'z4', name: 'Rooftop' },
  // Extra zones so horizontal overflow is actually testable.
  { id: 'z5', name: 'Terrace' },
  { id: 'z6', name: 'Poolside' },
]

type DemoTable = {
  id: string
  label: string
  zoneId: string
  status: TableStatus
  elapsedMinutes?: number
  itemCount?: number
}

const TABLES: DemoTable[] = [
  { id: 't1', label: 'B1', zoneId: 'z1', status: 'open' },
  { id: 't2', label: 'B2', zoneId: 'z1', status: 'occupied', elapsedMinutes: 42, itemCount: 7 },
  { id: 't3', label: 'S1', zoneId: 'z2', status: 'occupied', elapsedMinutes: 8, itemCount: 1 },
  { id: 't4', label: 'S2', zoneId: 'z2', status: 'unavailable' },
  { id: 't5', label: 'Table 4', zoneId: 'z3', status: 'open' },
  { id: 't6', label: 'Table 5', zoneId: 'z3', status: 'occupied', elapsedMinutes: 115 },
  { id: 't7', label: 'R1', zoneId: 'z4', status: 'open' },
  { id: 't8', label: 'R2', zoneId: 'z4', status: 'unavailable' },
]

export default function NavDemoPage() {
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)

  const visibleTables = useMemo(
    () => (activeZoneId ? TABLES.filter((t) => t.zoneId === activeZoneId) : TABLES),
    [activeZoneId],
  )

  const zoneName = ZONES.find((z) => z.id === activeZoneId)?.name ?? null
  const selectedTable = TABLES.find((t) => t.id === selectedTableId) ?? null

  return (
    <div className="min-h-screen">
      <ContextHeader
        restaurantName="Carpe Diem"
        staffName="Nina"
        zoneName={zoneName}
        tableLabel={selectedTable?.label ?? null}
        onNavigate={(level) => {
          if (level === 'zones') {
            setActiveZoneId(null)
            setSelectedTableId(null)
          } else {
            setSelectedTableId(null)
          }
        }}
        onStaffTap={() => alert('User switching is Story 2.4 (deferred)')}
      />

      <main className="flex flex-col gap-space-6 p-space-4">
        <ZoneChipBar
          zones={ZONES}
          activeZoneId={activeZoneId}
          onZoneChange={(id) => {
            setActiveZoneId(id)
            setSelectedTableId(null)
          }}
        />

        <div className="flex flex-wrap gap-space-4">
          {visibleTables.map((table) => (
            <TableCard
              key={table.id}
              label={table.label}
              zoneName={ZONES.find((z) => z.id === table.zoneId)?.name ?? ''}
              status={table.status}
              elapsedMinutes={table.elapsedMinutes}
              itemCount={table.itemCount}
              selected={table.id === selectedTableId}
              onSelect={() => setSelectedTableId(table.id)}
            />
          ))}
        </div>

        <p className="max-w-lg text-micro text-neutral-600">
          Scaffold for Story 3.1. Card size is driven by <code>[data-context]</code> — sign in as
          Nina (waiter, PIN 1234) for 80px cards, or Aruna (owner, PIN 5678) for 44px. Scroll the
          chip row sideways to confirm no scrollbar appears.
        </p>
      </main>
    </div>
  )
}
