/**
 * Changing a NOT-SENT line in place (Teran, 2026-11-03) — `editLine` against
 * the real store, with browser storage faked.
 *
 *   pnpm exec tsx src/components/pos/verify-edit-line.tsx
 */
const memory = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
  addEventListener: () => {},
}

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

async function main() {
  const { renderToString } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { useStagedRound } = await import('./use-staged-round')

  type Store = ReturnType<typeof useStagedRound>
  const session = '00000000-0000-4000-8000-000000000001'
  // The store is module state; render once to get its functions, then read
  // the round straight from storage after each call.
  let store: Store | null = null
  function Probe() {
    store = useStagedRound(session)
    return null
  }
  renderToString(createElement(Probe))
  const round = () => JSON.parse(memory.get(`${[...memory.keys()].find((k) => k.endsWith(session))}`) ?? '[]') as Store['lines']

  const rice = {
    id: 'rice', name: 'Fried Rice', pricePaisa: 120000, available: true,
    productionDestination: 'kitchen', modifierGroups: [],
  } as never
  const mojito = {
    id: 'mojito', name: 'Mojito', pricePaisa: 150000, available: true, productionDestination: 'bar',
    modifierGroups: [{
      id: 'g', name: 'Extra shots', required: false, selection: 'multi',
      options: [{ id: 'shot', name: 'Extra shot', priceDeltaPaisa: 50000, available: true, isDefault: false, maxCount: 3, excludesGroupId: null }],
    }],
  } as never
  const seat = { seatSlotId: 's1', seatLabel: 'Seat 1' }

  store!.addLine(rice, seat)
  const [plain] = round()
  store!.editLine(plain!.lineId, rice, { quantity: 1, modifierText: '  extra spicy ', optionIds: [] })
  let now = round()
  check('a note added afterwards changes the dish, not a second one',
    now.length === 1 && now[0]!.lineId === plain!.lineId && now[0]!.modifierText === 'extra spicy',
    JSON.stringify(now.map((l) => [l.name, l.quantity, l.modifierText])))

  store!.editLine(plain!.lineId, rice, { quantity: 3, modifierText: 'extra spicy', optionIds: [] })
  check('the quantity can be changed in the same sheet', round()[0]!.quantity === 3)

  // Two lines, then edit one to match the other: they become one.
  store!.addLine(rice, seat)
  now = round()
  const other = now.find((l) => l.modifierText === '')!
  store!.editLine(other.lineId, rice, { quantity: 2, modifierText: 'extra spicy', optionIds: [] })
  now = round()
  check('an edit that matches another line on the seat merges them',
    now.length === 1 && now[0]!.quantity === 5, JSON.stringify(now.map((l) => [l.modifierText, l.quantity])))

  store!.addLine(mojito, seat)
  const drink = round().find((l) => l.menuItemId === 'mojito')!
  store!.editLine(drink.lineId, mojito, { quantity: 1, modifierText: '', optionIds: ['shot', 'shot'] })
  const edited = round().find((l) => l.menuItemId === 'mojito')!
  check('changing options re-prices the line', edited.pricePaisa === 250000 && edited.options[0]?.count === 2,
    `${edited.pricePaisa} ${JSON.stringify(edited.options)}`)

  store!.editLine('no-such-line', rice, { quantity: 1, modifierText: 'x', optionIds: [] })
  check('a line that was sent meanwhile is left alone', round().length === 2)
}

main()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(() => {
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exitCode = results.every(Boolean) ? 0 : 1
  })
