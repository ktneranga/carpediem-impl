/**
 * Priced options — the rules, in ONE place (Story 4.8, FR65).
 *
 * Imported by the options sheet, the staged round, the order screen's
 * stale-price check AND the server's `submitRound`. If the client and the
 * server ever computed a price differently, every send of that dish would be
 * refused as PRICE_CHANGED — so there is exactly one implementation, and it
 * imports nothing from the server.
 */
import type { ModifierGroupRow } from '@/types/orders'

/**
 * A line's UNIT price: the dish plus every chosen option's change, never below
 * zero. "No alcohol" (−LKR 1,000) on a LKR 800 drink is LKR 0, not a refund.
 */
export function unitPriceFor(basePaisa: number, chosen: { priceDeltaPaisa: number }[]): number {
  const total = chosen.reduce((sum, option) => sum + option.priceDeltaPaisa, basePaisa)
  return Math.max(0, total)
}

/** "Double shot, No ice" — the chosen options as one line of text; null when none. */
export function optionText(chosen: { name: string }[] | null | undefined): string | null {
  if (!chosen || chosen.length === 0) return null
  return chosen.map((option) => option.name).join(', ')
}

/**
 * The options a one-tap add starts with: each group's DEFAULT, when it has one
 * that is available. Sorted, like every option-id list, so two lines with the
 * same choices compare equal.
 */
export function defaultOptionIds(groups: ModifierGroupRow[]): string[] {
  const ids: string[] = []
  for (const group of groups) {
    for (const option of group.options) {
      if (option.isDefault && option.available) {
        ids.push(option.id)
        // A single group takes at most one default, even if two are flagged.
        if (group.selection === 'single') break
      }
    }
  }
  return sortIds(ids)
}

/** Option ids in a stable order — the canonical form a line stores and compares. */
export function sortIds(ids: string[]): string[] {
  return [...ids].sort()
}

export type SelectionProblem = {
  reason: 'unknown' | 'unavailable' | 'duplicate' | 'too-many' | 'required'
  optionId?: string
  groupId?: string
}

/**
 * The first thing wrong with a set of chosen options for one dish, or null.
 *
 * - `unknown`: the id is not an option of THIS dish (another dish's, retired, or made up).
 * - `unavailable`: the option exists but is switched off.
 * - `duplicate`: the same id twice.
 * - `too-many`: two options in a `single` group.
 * - `required`: a required group with nothing chosen.
 *
 * Checked in that order, so the reason names the most specific problem.
 */
export function validateSelection(
  groups: ModifierGroupRow[],
  optionIds: string[],
): SelectionProblem | null {
  const owner = new Map<string, { groupId: string; available: boolean }>()
  for (const group of groups) {
    for (const option of group.options) {
      owner.set(option.id, { groupId: group.id, available: option.available })
    }
  }

  const seen = new Set<string>()
  const perGroup = new Map<string, number>()
  for (const id of optionIds) {
    const found = owner.get(id)
    if (!found) return { reason: 'unknown', optionId: id }
    if (!found.available) return { reason: 'unavailable', optionId: id, groupId: found.groupId }
    if (seen.has(id)) return { reason: 'duplicate', optionId: id, groupId: found.groupId }
    seen.add(id)
    perGroup.set(found.groupId, (perGroup.get(found.groupId) ?? 0) + 1)
  }

  for (const group of groups) {
    const count = perGroup.get(group.id) ?? 0
    if (group.selection === 'single' && count > 1) return { reason: 'too-many', groupId: group.id }
    if (group.required && count === 0) return { reason: 'required', groupId: group.id }
  }
  return null
}

/** The chosen options, as `{id, name, priceDeltaPaisa, group}`, in menu order. */
export function chosenOptions(
  groups: ModifierGroupRow[],
  optionIds: string[],
): { id: string; name: string; priceDeltaPaisa: number; group: string }[] {
  const wanted = new Set(optionIds)
  const chosen: { id: string; name: string; priceDeltaPaisa: number; group: string }[] = []
  for (const group of groups) {
    for (const option of group.options) {
      if (wanted.has(option.id)) {
        chosen.push({
          id: option.id,
          name: option.name,
          priceDeltaPaisa: option.priceDeltaPaisa,
          group: group.name,
        })
      }
    }
  }
  return chosen
}
