/**
 * Shared design-system maps — Carpe Diem RMS Design System v1.0.
 *
 * `STATUS_TONES` and `ZONE_ICONS` are the system's exported lookups. They live
 * here rather than inside a component because more than one component reads
 * them, and because a status tone drifting between the table card and the
 * status pill is exactly the failure the tinted-pair rule exists to prevent.
 */

import {
  Armchair,
  Beer,
  CakeSlice,
  ChefHat,
  Coffee,
  Croissant,
  Drumstick,
  Fish,
  Flame,
  LayoutGrid,
  Pizza,
  Salad,
  Sandwich,
  Soup,
  Umbrella,
  Utensils,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'

/**
 * Values match `tableStatusEnum` in the schema EXACTLY:
 *   pgEnum('table_status', ['open', 'occupied', 'unavailable'])
 *
 * epics.md calls the third state "closed" and the older UX spec called it
 * "alert". Neither exists in the database.
 */
export type TableStatus = 'open' | 'occupied' | 'unavailable'

/**
 * Each status is a quintuple: a saturated edge for borders, a DARKER band fill
 * that clears 4.5:1 against the white text sitting on it, a pale chip fill, a
 * paler body tint, and a dark ink. Always used as a set — a tint without its
 * ink fails contrast, and an edge without its word fails the colour rule.
 *
 * `label` is not optional decoration. Colour never carries meaning alone.
 */
export const STATUS_TONES: Record<
  TableStatus,
  { label: string; band: string; body: string; chip: string; ink: string; edge: string }
> = {
  open: {
    label: 'Open',
    band: 'bg-open-band',
    body: 'bg-open-body',
    chip: 'bg-open-chip',
    ink: 'text-open-ink',
    edge: 'border-open-edge',
  },
  occupied: {
    label: 'Occupied',
    band: 'bg-occupied-band',
    body: 'bg-occupied-body',
    chip: 'bg-occupied-chip',
    ink: 'text-occupied-ink',
    edge: 'border-occupied-edge',
  },
  unavailable: {
    label: 'Unavailable',
    band: 'bg-unavailable-band',
    body: 'bg-unavailable-body',
    chip: 'bg-unavailable-chip',
    ink: 'text-unavailable-ink',
    edge: 'border-unavailable-edge',
  },
}

/**
 * Fixed zone → icon mappings. A waiter learns these once; they must not shuffle
 * between releases. Zones are matched on name because the database generates
 * zone ids per tenant — an unmatched zone falls back to the all-zones glyph
 * rather than rendering nothing.
 */
const ZONE_ICONS: Record<string, LucideIcon> = {
  'bean bags': Armchair,
  'sun beds': Umbrella,
  tables: Utensils,
  rooftop: Flame,
}

export const ALL_ZONES_ICON: LucideIcon = LayoutGrid

export function zoneIcon(zoneName: string): LucideIcon {
  return ZONE_ICONS[zoneName.trim().toLowerCase()] ?? LayoutGrid
}

/**
 * Route colours are the only non-status accents in the system. Routing is
 * derived from the item — a waiter never picks it.
 */
export const ROUTES = {
  kitchen: { label: 'Kitchen', chip: 'bg-route-kitchen' },
  pizza: { label: 'Pizza Kitchen', chip: 'bg-route-pizza' },
  bar: { label: 'Bar', chip: 'bg-route-bar' },
} as const

export type RouteKey = keyof typeof ROUTES

/**
 * An icon per menu category, for the order screen's filter chips.
 *
 * Same shape as `zoneIcon` above, and for the same reason: more than one place
 * will want it, and a category showing a different icon on the chip than on a
 * card's fallback tile is exactly the drift these lookups exist to prevent.
 *
 * Keyed on the category NAME, lowercased, because categories are owner-configured
 * free text — there is no enum to switch on, and there should not be: a
 * restaurant that invents "Beach Grill" gets the sensible default rather than a
 * migration. Names here cover the common cases across the menus this product
 * targets; add rows freely, never a required column.
 *
 * The word always accompanies the icon on the chip. An icon alone is a guess.
 */
const MENU_CATEGORY_ICONS: Record<string, LucideIcon> = {
  starters: Salad,
  appetizers: Salad,
  appetisers: Salad,
  salads: Salad,
  soups: Soup,
  breakfast: Croissant,
  mains: UtensilsCrossed,
  'main course': UtensilsCrossed,
  'main courses': UtensilsCrossed,
  pizza: Pizza,
  pizzas: Pizza,
  pasta: ChefHat,
  seafood: Fish,
  grill: Flame,
  bbq: Flame,
  burgers: Sandwich,
  sandwiches: Sandwich,
  chicken: Drumstick,
  sides: Utensils,
  desserts: CakeSlice,
  dessert: CakeSlice,
  drinks: Beer,
  beverages: Beer,
  bar: Beer,
  'hot drinks': Coffee,
  coffee: Coffee,
  tea: Coffee,
}

export function menuCategoryIcon(categoryName: string): LucideIcon {
  return MENU_CATEGORY_ICONS[categoryName.trim().toLowerCase()] ?? Utensils
}
