/**
 * The bar's menu (Teran, 2026-10-30): the categories a bar tab shows.
 *
 * SAMPLE items at Teran's example prices — a cocktail 2,500, a mocktail 1,500,
 * a shot 1,000 — until the back office manages the menu. Every item is made at
 * the BAR, which is what puts it on a bar tab's menu (`production_destination`).
 *
 * Shared by `seed.ts` (a fresh install) and `seed-bar-menu.ts` (a database
 * seeded before the bar existed), so the two cannot drift.
 *
 * Priced options — double shot, no alcohol — are Stage B, not here.
 */
export type SeedItem = {
  name: string
  pricePaisa: number
  destination: 'kitchen' | 'pizza_kitchen' | 'bar'
  available?: boolean
  portionCount?: number
}

export const BAR_MENU: { category: string; items: SeedItem[] }[] = [
  {
    category: 'Cocktails',
    items: [
      { name: 'Mojito', pricePaisa: 250000, destination: 'bar' },
      { name: 'Piña Colada', pricePaisa: 280000, destination: 'bar' },
      { name: 'Long Island Iced Tea', pricePaisa: 320000, destination: 'bar' },
      { name: 'Arrack & Soda', pricePaisa: 70000, destination: 'bar' },
    ],
  },
  {
    category: 'Mocktails',
    items: [
      { name: 'Virgin Mojito', pricePaisa: 150000, destination: 'bar' },
      { name: 'Passion Fruit Cooler', pricePaisa: 120000, destination: 'bar' },
      { name: 'King Coconut', pricePaisa: 35000, destination: 'bar', portionCount: 25 },
      { name: 'Fresh Lime Soda', pricePaisa: 40000, destination: 'bar' },
    ],
  },
  {
    category: 'Coffee',
    items: [
      { name: 'Espresso', pricePaisa: 60000, destination: 'bar' },
      { name: 'Cappuccino', pricePaisa: 90000, destination: 'bar' },
      { name: 'Iced Coffee', pricePaisa: 100000, destination: 'bar' },
    ],
  },
  {
    category: 'Tea',
    items: [
      { name: 'Ceylon Black Tea', pricePaisa: 40000, destination: 'bar' },
      { name: 'Ginger Tea', pricePaisa: 50000, destination: 'bar' },
      { name: 'Iced Lemon Tea', pricePaisa: 70000, destination: 'bar' },
    ],
  },
  {
    category: 'Beer',
    items: [
      { name: 'Lion Lager', pricePaisa: 55000, destination: 'bar', portionCount: 48 },
      { name: 'Lion Stout', pricePaisa: 80000, destination: 'bar' },
      { name: 'Carlsberg', pricePaisa: 75000, destination: 'bar' },
    ],
  },
  {
    category: 'Whisky',
    items: [
      { name: 'Johnnie Walker Red (shot)', pricePaisa: 100000, destination: 'bar' },
      { name: 'Jameson (shot)', pricePaisa: 120000, destination: 'bar' },
      { name: 'Johnnie Walker Black (shot)', pricePaisa: 150000, destination: 'bar' },
    ],
  },
]
