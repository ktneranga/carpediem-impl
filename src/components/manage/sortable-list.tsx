'use client'

import { useState, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A list reordered by dragging a handle (Teran, 2026-11-13: arrows were tedious).
 *
 * Only the ⠿ handle starts a drag, so the text fields and buttons in a row stay
 * usable on a tablet. Mouse, touch (a short press, so a scroll is not a drag)
 * and keyboard (focus the handle, Space, arrows, Space) all work.
 *
 * The new order shows at once (`pending`) while `onReorder` saves it; when the
 * save settles the list falls back to `items`, which by then is the server's
 * order — or, if the save failed, the old one. No effect syncs the two.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  disabled = false,
  label,
  renderItem,
  className,
  itemClassName,
}: {
  items: T[]
  onReorder: (ids: string[]) => Promise<unknown>
  disabled?: boolean
  /** For the handle's accessible name: "Drag Starters". */
  label: (item: T) => string
  renderItem: (item: T, handle: ReactNode) => ReactNode
  className?: string
  itemClassName?: string
}) {
  const [pending, setPending] = useState<string[] | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const byId = new Map(items.map((item) => [item.id, item]))
  const order = (pending ?? items.map((item) => item.id)).filter((id) => byId.has(id))

  async function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))
    setPending(next)
    try {
      await onReorder(next)
    } finally {
      setPending(null)
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy} disabled={disabled}>
        <ul className={className}>
          {order.map((id) => {
            const item = byId.get(id)!
            return (
              <SortableRow key={id} id={id} label={label(item)} disabled={disabled} className={itemClassName}>
                {(handle) => renderItem(item, handle)}
              </SortableRow>
            )
          })}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function SortableRow({
  id,
  label,
  disabled,
  className,
  children,
}: {
  id: string
  label: string
  disabled: boolean
  className?: string
  children: (handle: ReactNode) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      aria-label={`Drag ${label}`}
      disabled={disabled}
      className={cn(
        'inline-flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-control text-slate-400 night:text-night-muted',
        'hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing disabled:opacity-30 night:hover:bg-night-raised night:hover:text-night-second',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical aria-hidden="true" className="size-5" />
    </button>
  )
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(className, isDragging && 'relative z-10 rounded-control bg-white shadow-el-2 night:bg-night-card')}
    >
      {children(handle)}
    </li>
  )
}
