/**
 * The menu as an Excel workbook, both ways (spec-menu-bulk-upload-excel).
 *
 * `buildMenuWorkbook` writes the current menu — the file Manage → Menu → Bulk
 * upload downloads; `parseMenuWorkbook` reads a filled one back into rows,
 * checking every cell the way the menu editor would. The SAME columns go out
 * and come back, so "download, edit, upload" is also how many prices are
 * changed at once.
 *
 * Pure (no database, no `server-only`): the import service, the route and a
 * one-off script that makes a restaurant's starting sheet all use it.
 */
import ExcelJS from 'exceljs'
import type { Destination, ManageCategory } from '@/server/services/menu-admin.service'

export const DISHES_SHEET = 'Dishes'
export const OPTIONS_SHEET = 'Options'
const HELP_SHEET = 'How to'

/** Same limits as the menu editor (`cleanName`, `checkPrice`, `checkMaxCount`). */
const MAX_NAME = 60
const MAX_RUPEES = 10_000_000
/** One upload. A whole restaurant menu is a few hundred rows. */
export const MAX_ROWS = 1000

const DISH_COLUMNS = ['Category', 'Dish', 'Price (LKR)', 'Station'] as const
const OPTION_COLUMNS = [
  'Category',
  'Dish',
  'Option group',
  'Choose',
  'Required',
  'Option',
  'Extra price (LKR)',
  'Default',
  'Max per dish',
] as const

const STATIONS: Record<Destination, string> = { kitchen: 'Kitchen', pizza_kitchen: 'Pizza kitchen', bar: 'Bar' }

export type DishRow = { row: number; category: string; name: string; pricePaisa: number; destination: Destination }
/**
 * A blank cell is `undefined`, not a default: on an EXISTING group or option a
 * blank leaves the live value alone (a row added to a "Milk" group must not
 * turn it optional). New ones take the defaults (One, No, 0, No, 1).
 */
export type OptionRow = {
  row: number
  category: string
  dish: string
  group: string
  selection: 'single' | 'multi' | undefined
  isRequired: boolean | undefined
  option: string
  priceDeltaPaisa: number | undefined
  isDefault: boolean | undefined
  maxCount: number | undefined
}
export type SheetError = { sheet: string; row: number; message: string }
export type ParsedMenu = { dishes: DishRow[]; options: OptionRow[]; errors: SheetError[] }

/** Case- and space-insensitive key for matching names. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

// ── Writing ──────────────────────────────────────────────────────────────────

/** The current menu (switched-on rows) as the upload format, with a How to sheet. */
export async function buildMenuWorkbook(categories: ManageCategory[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.creator = 'Carpe Diem POS'

  const dishes = sheet(book, DISHES_SHEET, DISH_COLUMNS, [24, 40, 14, 16])
  const options = sheet(book, OPTIONS_SHEET, OPTION_COLUMNS, [22, 32, 20, 10, 10, 22, 16, 10, 12])
  for (const category of categories.filter((c) => c.isActive)) {
    for (const item of category.items.filter((i) => i.isActive)) {
      dishes.addRow([category.name, item.name, item.pricePaisa / 100, STATIONS[item.productionDestination]])
      for (const group of item.groups) {
        for (const option of group.options) {
          options.addRow([
            category.name,
            item.name,
            group.name,
            group.selection === 'multi' ? 'Many' : 'One',
            group.isRequired ? 'Yes' : 'No',
            option.name,
            option.priceDeltaPaisa / 100,
            option.isDefault ? 'Yes' : 'No',
            option.maxCount,
          ])
        }
      }
    }
  }
  // Dropdowns down to the row limit, so new rows get them too.
  // exceljs supports a validation over a range at runtime; its types only
  // declare the per-cell form.
  type Ranged = { dataValidations: { add: (range: string, validation: ExcelJS.DataValidation) => void } }
  const dropdown = (ws: ExcelJS.Worksheet, column: string, values: string[]) =>
    (ws as unknown as Ranged).dataValidations.add(`${column}2:${column}${MAX_ROWS + 1}`, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${values.join(',')}"`],
    })
  dropdown(dishes, 'D', Object.values(STATIONS))
  dropdown(options, 'D', ['One', 'Many'])
  dropdown(options, 'E', ['Yes', 'No'])
  dropdown(options, 'H', ['Yes', 'No'])

  const help = book.addWorksheet(HELP_SHEET)
  help.getColumn(1).width = 110
  for (const line of HELP) help.addRow([line])
  help.getRow(1).font = { bold: true, size: 14 }

  return Buffer.from(await book.xlsx.writeBuffer())
}

const HELP = [
  'How to fill in this menu',
  '',
  'Dishes sheet — one row per dish:',
  '  Category: e.g. Brunch, Pizza, Coffee. New names make new categories, in the order they first appear.',
  '  Dish: the name waiters see and the bill prints (up to 60 characters).',
  '  Price (LKR): whole rupees, e.g. 2300. No decimals.',
  '  Station: where the ticket prints — Kitchen, Pizza kitchen or Bar. Drinks can still be ordered from any table.',
  '',
  'Options sheet — optional; leave it empty if dishes have no choices:',
  '  One row per choice. Category + Dish must match a dish in the Dishes sheet or already on the menu.',
  '  Option group: e.g. Milk. Choose: One (pick one) or Many. Required: Yes if the waiter must choose.',
  '  Option: e.g. Oat milk. Extra price: added to the dish (0 if free; may be negative, e.g. -500).',
  '  Default: Yes to preselect it. Max per dish: how many times it can be added (1 to 10, usually 1).',
  '  Choose and Required belong to the group: give them on any of its rows; rows that disagree are refused.',
  '  A blank cell on an option or group already on the menu leaves its current value unchanged.',
  '',
  'Uploading again:',
  '  Rows are matched by name (capital letters and extra spaces do not matter).',
  '  A matching dish gets the new price and station; new rows are added; nothing is ever deleted.',
  '  To take a dish off the menu, switch it off in Manage → Menu.',
  '',
  'Upload in Manage → Menu → Bulk upload. It is checked first and shows what will change; nothing is saved until you press Import.',
]

function sheet(book: ExcelJS.Workbook, name: string, columns: readonly string[], widths: number[]) {
  const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = columns.map((header, index) => ({ header, width: widths[index] }))
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  return ws
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * A cell as text, whatever Excel stored: number, rich text, formula result,
 * link. `BAD_CELL` for what cannot be read honestly: an error (#REF!), a
 * formula with no saved result, or a DATE — Excel turns a typed "1/2" into one,
 * and saving it as "2026-01-02…" would be inventing a name.
 */
const BAD_CELL = '\u0000bad'
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  if (value instanceof Date) return BAD_CELL
  if (typeof value === 'object') {
    if ('error' in value) return BAD_CELL
    if ('richText' in value) return value.richText.map((part) => part.text).join('')
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result
      return result === undefined || result === null ? BAD_CELL : cellText(result)
    }
    if ('text' in value) return String(value.text)
  }
  return ''
}

/** Rupees as typed ("2300", "2,300", "Rs. 2300", 2300) → paisa; null when not whole rupees. */
function rupees(text: string, { allowNegative }: { allowNegative: boolean }): number | null {
  const cleaned = text.replace(/(lkr|rs\.?)/gi, '').replace(/[,\s]/g, '')
  if (!/^-?\d+(\.0+)?$/.test(cleaned)) return null
  const value = Math.trunc(Number(cleaned))
  if (Math.abs(value) > MAX_RUPEES || (!allowNegative && value < 0)) return null
  return value * 100
}

function yesNo(text: string, fallback: boolean): boolean | null {
  const t = text.trim().toLowerCase()
  if (t === '') return fallback
  if (['yes', 'y', 'true', '1'].includes(t)) return true
  if (['no', 'n', 'false', '0'].includes(t)) return false
  return null
}

function station(text: string): Destination | null {
  const t = text.trim().toLowerCase().replace(/[_\s]+/g, ' ')
  if (t === 'kitchen') return 'kitchen'
  if (t === 'pizza kitchen' || t === 'pizza') return 'pizza_kitchen'
  if (t === 'bar') return 'bar'
  return null
}

function cleanName(text: string): string | null {
  const name = text.trim().replace(/\s+/g, ' ')
  return name.length >= 1 && name.length <= MAX_NAME ? name : null
}

/** Reads a filled workbook. Every problem is listed (sheet, row), not just the first. */
export async function parseMenuWorkbook(buffer: ArrayBuffer | Buffer): Promise<ParsedMenu> {
  const errors: SheetError[] = []
  const book = new ExcelJS.Workbook()
  try {
    await book.xlsx.load(buffer as ArrayBuffer)
  } catch {
    return { dishes: [], options: [], errors: [{ sheet: '', row: 0, message: 'This is not an Excel (.xlsx) file' }] }
  }
  const dishSheet = book.getWorksheet(DISHES_SHEET)
  if (!dishSheet) {
    return {
      dishes: [],
      options: [],
      errors: [{ sheet: '', row: 0, message: `No "${DISHES_SHEET}" sheet: use the file Bulk upload downloads` }],
    }
  }

  /** Rows with any text, as trimmed strings by column (1-based), with their row numbers. */
  const rowsOf = (ws: ExcelJS.Worksheet | undefined, width: number) => {
    const out: { row: number; cells: string[] }[] = []
    ws?.eachRow((row, number) => {
      if (number === 1) return
      const cells = Array.from({ length: width }, (_, i) => cellText(row.getCell(i + 1).value).trim())
      if (cells.some((cell) => cell !== '')) out.push({ row: number, cells })
    })
    return out
  }

  // The columns are read by position, so the header row must be the one the
  // download has: a deleted header or a moved column would shift every value.
  const headerOk = (ws: ExcelJS.Worksheet | undefined, columns: readonly string[]) =>
    !ws || ws.actualRowCount === 0 || columns.every((title, i) => nameKey(cellText(ws.getRow(1).getCell(i + 1).value)) === nameKey(title))
  const optionSheet = book.getWorksheet(OPTIONS_SHEET)
  for (const [ws, name, columns] of [[dishSheet, DISHES_SHEET, DISH_COLUMNS], [optionSheet, OPTIONS_SHEET, OPTION_COLUMNS]] as const) {
    if (!headerOk(ws, columns)) {
      return {
        dishes: [],
        options: [],
        errors: [{ sheet: name, row: 1, message: `Row 1 must be the headings ${columns.join(', ')}, in that order: use the downloaded sheet` }],
      }
    }
  }

  const dishRows = rowsOf(dishSheet, DISH_COLUMNS.length)
  const optionRows = rowsOf(optionSheet, OPTION_COLUMNS.length)
  if (dishRows.length + optionRows.length > MAX_ROWS) {
    return { dishes: [], options: [], errors: [{ sheet: '', row: 0, message: `At most ${MAX_ROWS} rows in one upload` }] }
  }

  const dishes: DishRow[] = []
  const seenDishes = new Map<string, number>()
  for (const { row, cells } of dishRows) {
    const fail = (message: string) => errors.push({ sheet: DISHES_SHEET, row, message })
    if (cells.includes(BAD_CELL)) {
      fail('A cell holds a date, an error (#REF!) or an unsaved formula: type plain text or numbers')
      continue
    }
    const category = cleanName(cells[0]!)
    const name = cleanName(cells[1]!)
    const pricePaisa = rupees(cells[2]!, { allowNegative: false })
    const destination = station(cells[3]!)
    if (!category) fail('Category: 1 to 60 characters')
    if (!name) fail('Dish: 1 to 60 characters')
    if (pricePaisa === null) fail('Price: whole rupees, e.g. 2300')
    if (!destination) fail('Station: Kitchen, Pizza kitchen or Bar')
    if (!category || !name || pricePaisa === null || !destination) continue
    const key = `${nameKey(category)}|${nameKey(name)}`
    const first = seenDishes.get(key)
    if (first) {
      fail(`"${name}" in ${category} is already on row ${first}`)
      continue
    }
    seenDishes.set(key, row)
    dishes.push({ row, category, name, pricePaisa, destination })
  }

  const options: OptionRow[] = []
  const seenOptions = new Map<string, number>()
  for (const { row, cells } of optionRows) {
    const fail = (message: string) => errors.push({ sheet: OPTIONS_SHEET, row, message })
    if (cells.includes(BAD_CELL)) {
      fail('A cell holds a date, an error (#REF!) or an unsaved formula: type plain text or numbers')
      continue
    }
    const [categoryText, dishText, groupText, chooseText, requiredText, optionText, priceText, defaultText, maxText] = cells
    const category = cleanName(categoryText!)
    const dish = cleanName(dishText!)
    const group = cleanName(groupText!)
    const option = cleanName(optionText!)
    const choose = chooseText!.trim().toLowerCase()
    // Blank → undefined (see OptionRow); null → not a valid value.
    const selection =
      choose === '' ? undefined : choose === 'one' || choose === 'single' ? 'single' : choose === 'many' || choose === 'multi' ? 'multi' : null
    const isRequired = requiredText === '' ? undefined : yesNo(requiredText!, false)
    const priceDeltaPaisa = priceText === '' ? undefined : rupees(priceText!, { allowNegative: true })
    const isDefault = defaultText === '' ? undefined : yesNo(defaultText!, false)
    const maxCount = maxText === '' ? undefined : /^\d+$/.test(maxText!) ? Number(maxText) : NaN
    if (!category) fail('Category: 1 to 60 characters')
    if (!dish) fail('Dish: 1 to 60 characters')
    if (!group) fail('Option group: 1 to 60 characters')
    if (!option) fail('Option: 1 to 60 characters')
    if (selection === null) fail('Choose: One or Many')
    if (isRequired === null) fail('Required: Yes or No')
    if (priceDeltaPaisa === null) fail('Extra price: whole rupees, e.g. 200 or -500')
    if (isDefault === null) fail('Default: Yes or No')
    const maxOk = maxCount === undefined || (maxCount >= 1 && maxCount <= 10)
    if (!maxOk) fail('Max per dish: 1 to 10')
    if (!category || !dish || !group || !option || selection === null || isRequired === null || priceDeltaPaisa === null || isDefault === null || !maxOk) {
      continue
    }
    const key = [category, dish, group, option].map(nameKey).join('|')
    const first = seenOptions.get(key)
    if (first) {
      fail(`"${option}" in ${group} is already on row ${first}`)
      continue
    }
    seenOptions.set(key, row)
    options.push({ row, category, dish, group, selection, isRequired, option, priceDeltaPaisa, isDefault, maxCount })
  }

  return { dishes, options, errors }
}
