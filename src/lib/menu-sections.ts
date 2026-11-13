/**
 * A drinks category, the order screen's rule (`menu-browser.tsx`): a drink is a
 * dish the BAR makes. A category whose active dishes all print at the bar is
 * listed under Drinks; anything else, and an empty one, under Food.
 *
 * Shared by Manage → Menu (Story 10.4) and Manage → Sold out (Story 8.3), so
 * the two screens split the menu the same way.
 */
export function isDrinksCategory(category: {
  items: { isActive: boolean; productionDestination: string }[]
}): boolean {
  const active = category.items.filter((item) => item.isActive)
  return active.length > 0 && active.every((item) => item.productionDestination === 'bar')
}
