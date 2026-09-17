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

/**
 * Zones where orders are taken per seat. Everywhere else, one order is one
 * party and the seat section is hidden.
 *
 * Teran, 2026-09-16: seats earn their place at the Tables zone, where several
 * guests at one table order separately and may pay separately. On bean bags,
 * sun beds and the rooftop — and at the counter — they were an extra decision
 * with no payoff. Orders there still HAVE a seat (every session is created with
 * Seat 1), so items are attributed exactly as before; only the choice is gone.
 * The cost is that those orders cannot be split by seat at billing time.
 *
 * ⚠️ Keyed on the zone NAME, like `ZONE_ICONS` above, because zones are
 * owner-configured and there is no column for it. Renaming "Tables" switches
 * seats off there. If that ever bites, this becomes a per-zone setting.
 */
const SEATED_ZONES = new Set(['tables'])

export function zoneUsesSeats(zoneName: string | null): boolean {
  // A counter sale has no zone, and no seats.
  return zoneName !== null && SEATED_ZONES.has(zoneName.trim().toLowerCase())
}

export function zoneIcon(zoneName: string): LucideIcon {
  return ZONE_ICONS[zoneName.trim().toLowerCase()] ?? LayoutGrid
}

/**
 * Route colours are the only non-status accents in the system. Routing is
 * derived from the item — a waiter never picks it.
 *
 * `band` and `chip` fill shapes; `ink` colours TEXT, and is not always the route
 * colour. Kitchen blue (#2288B4) is 4.00:1 on white, which fails WCAG AA for the
 * 12px eyebrow it would label, so kitchen text uses brand-700 (6.03:1) — the
 * same hue, darker. Pizza (5.18:1) and Bar (5.70:1) pass as they are.
 */
export const ROUTES = {
  kitchen: {
    label: 'Kitchen',
    short: 'Kitchen',
    chip: 'bg-route-kitchen',
    band: 'bg-route-kitchen',
    ink: 'text-brand-700',
  },
  pizza: {
    label: 'Pizza Kitchen',
    short: 'Pizza',
    chip: 'bg-route-pizza',
    band: 'bg-route-pizza',
    ink: 'text-route-pizza',
  },
  bar: {
    label: 'Bar',
    short: 'Bar',
    chip: 'bg-route-bar',
    band: 'bg-route-bar',
    ink: 'text-route-bar',
  },
} as const

export type RouteKey = keyof typeof ROUTES

/**
 * `menu_items.production_destination` → its route.
 *
 * The database says `pizza_kitchen`; the design system says `pizza`. One map,
 * here, rather than a string translation in every component that colours a dish.
 */
export function routeForDestination(
  destination: 'kitchen' | 'pizza_kitchen' | 'bar',
): (typeof ROUTES)[RouteKey] {
  return ROUTES[destination === 'pizza_kitchen' ? 'pizza' : destination]
}

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
