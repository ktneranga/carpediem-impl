'use client'

import { useEffect, useRef } from 'react'
import { QrCode } from 'lucide-react'
import { amountLines, foldToAscii, PAPER_COLUMNS, receiptMoney, wrapLine } from '@/server/print/escpos'
import { percentFromBp } from '@/lib/format'
import { rasterToRgba, type LogoRaster } from '@/lib/logo-raster'
import { cn } from '@/lib/utils'

/**
 * A picture of the printed bill, drawn from the Settings form as it is typed —
 * before it is saved (Teran, 2026-11-15). Lines wrap with the printer's own
 * helpers (`wrapLine`, `amountLines`, 48 columns), so a header line too long
 * for the paper breaks here exactly where it will break on the roll. The
 * layout follows `buildReceipt`: logo, name (double size), header, table,
 * date, dishes, money, footer, QR.
 *
 * The QR is a placeholder: drawing a real one would need a library, and the
 * printer makes its own from the link.
 */

/** Paper is 576 dots across at 48 columns: the logo's share of the width. */
const PAPER_DOTS = 576

type Line = { text: string; centre?: boolean; bold?: boolean; size?: 'double' | 'tall' }

const SAMPLE_DISHES = [
  { quantity: 2, name: 'Margherita Pizza', amountPaisa: 320_000 },
  { quantity: 1, name: 'Iced Coffee', amountPaisa: 85_000 },
]

/** The printer prints a QR only for this (`buildReceipt`). */
const PRINTABLE_QR = /^[\x21-\x7e]{1,300}$/
/** Save's limits on header and footer (`settings.service` `checkLines`). */
const MAX_LINES = 6

function shortLink(url: string): string {
  const bare = url.replace(/^https?:\/\//, '')
  return bare.length > 36 ? `${bare.slice(0, 35)}…` : bare
}

/** What Save will refuse in a header or footer, in words; null when it is fine. */
function lineProblem(label: string, text: string): string | null {
  const lines = textLines(text)
  if (lines.length > MAX_LINES) return `${label}: ${lines.length} lines, at most ${MAX_LINES}.`
  const long = lines.findIndex((line) => foldToAscii(line).length > PAPER_COLUMNS)
  return long === -1 ? null : `${label} line ${long + 1} is longer than ${PAPER_COLUMNS} characters.`
}

function textLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function centred(text: string, extra: Omit<Line, 'text' | 'centre'> = {}, columns = PAPER_COLUMNS): Line[] {
  const folded = foldToAscii(text)
  if (folded.trim() === '') return []
  return wrapLine(folded, 0, columns).map((line) => ({ text: line.trim(), centre: true, ...extra }))
}

export function SampleBill({
  restaurantName,
  header,
  footer,
  logo,
  qrUrl,
  qrCaption,
  serviceBp,
  taxBp,
}: {
  restaurantName: string
  header: string
  footer: string
  logo: LogoRaster | null
  qrUrl: string
  qrCaption: string
  /** Basis points; null while the field is not a valid percent. */
  serviceBp: number | null
  taxBp: number | null
}) {
  // The same arithmetic as `computeBillTotals` (bill.service.ts, server-only):
  // service on the subtotal, tax on subtotal + service, each rounded once.
  const subtotal = SAMPLE_DISHES.reduce((sum, dish) => sum + dish.amountPaisa, 0)
  const service = serviceBp ? Math.round((subtotal * serviceBp) / 10_000) : 0
  const tax = taxBp ? Math.round(((subtotal + service) * taxBp) / 10_000) : 0
  const row = (left: string, paisa: number, extra: Omit<Line, 'text'> = {}): Line[] =>
    amountLines(left, receiptMoney(paisa)).map((text) => ({ text, ...extra }))
  const divider: Line = { text: '-'.repeat(PAPER_COLUMNS) }
  const now = new Date()
  const stamp = `${now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}  ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`

  const top: Line[] = [
    ...centred(restaurantName || 'Bill', { bold: true, size: 'double' }, PAPER_COLUMNS / 2),
    ...textLines(header).flatMap((line) => centred(line)),
    ...centred('Table 5', { bold: true }),
    { text: stamp },
    { text: 'Waiter: Staff' },
    divider,
    ...SAMPLE_DISHES.flatMap((dish) => row(`${dish.quantity} x ${dish.name}`, dish.amountPaisa)),
    divider,
    ...row('Subtotal', subtotal),
    ...(serviceBp ? row(`Service ${percentFromBp(serviceBp)}%`, service) : []),
    ...(taxBp ? row(`Tax ${percentFromBp(taxBp)}%`, tax) : []),
    ...row('Total', subtotal + service + tax, { bold: true, size: 'tall' }),
  ]
  const footerLines = textLines(footer)
  const foot: Line[] = footerLines.length > 0 ? [divider, ...footerLines.flatMap((line) => centred(line))] : []
  const link = qrUrl.trim()
  const qrPrints = PRINTABLE_QR.test(link)
  const problems = [
    lineProblem('Header', header),
    lineProblem('Footer', footer),
    link !== '' && !qrPrints ? 'The QR link has spaces or symbols the printer cannot put in a QR.' : null,
  ].filter((problem): problem is string => problem !== null)

  return (
    <figure aria-label="Sample bill" className="flex flex-col items-center gap-sp-2">
      <div
        className="w-fit max-w-full overflow-x-auto rounded-sm bg-white px-sp-4 py-sp-5 font-mono text-[10.5px] leading-[1.45] text-black shadow-md ring-1 ring-slate-200 night:ring-0"
        // Torn-paper feel without an image: a zigzag bottom edge.
        style={{ clipPath: 'polygon(0 0,100% 0,100% calc(100% - 6px),95% 100%,90% calc(100% - 6px),85% 100%,80% calc(100% - 6px),75% 100%,70% calc(100% - 6px),65% 100%,60% calc(100% - 6px),55% 100%,50% calc(100% - 6px),45% 100%,40% calc(100% - 6px),35% 100%,30% calc(100% - 6px),25% 100%,20% calc(100% - 6px),15% 100%,10% calc(100% - 6px),5% 100%,0 calc(100% - 6px))' }}
      >
        <div style={{ width: `${PAPER_COLUMNS}ch` }}>
          {logo ? <Logo logo={logo} /> : null}
          {top.map((line, index) => (
            <PaperLine key={index} line={line} />
          ))}
          {foot.map((line, index) => (
            <PaperLine key={`f${index}`} line={line} />
          ))}
          {qrPrints ? (
            <div className="flex flex-col items-center pt-[1.45em]">
              <div className="flex size-24 flex-col items-center justify-center gap-1 border border-dashed border-slate-400 text-slate-500">
                <QrCode className="size-10" aria-hidden="true" />
                <span className="max-w-full truncate px-1 text-[9px]">{shortLink(link)}</span>
              </div>
              {qrCaption.trim() !== '' ? centred(qrCaption).map((line, index) => <PaperLine key={`q${index}`} line={line} />) : null}
            </div>
          ) : null}
          <PaperLine line={divider} />
          <PaperLine line={{ text: 'Order 20261115-042' }} />
        </div>
      </div>
      {problems.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-sp-1 rounded-control bg-amber-50 px-sp-3 py-sp-2 text-fs-12 font-semibold text-amber-900 night:bg-amber-500/10 night:text-amber-300">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <figcaption className="text-center text-fs-12 text-slate-500 night:text-night-muted">
        Sample with made-up dishes. Updates as you type; saved bills use it after Save.
        {qrPrints ? <span className="block">The printer draws the real QR from your link.</span> : null}
      </figcaption>
    </figure>
  )
}

function PaperLine({ line }: { line: Line }) {
  return (
    <div
      className={cn('whitespace-pre', line.centre ? 'text-center' : '', line.bold ? 'font-bold' : '')}
      style={
        line.size === 'double'
          ? { fontSize: '2em', lineHeight: 1.2 }
          : line.size === 'tall'
            ? { transform: 'scaleY(2)', margin: '0.6em 0' }
            : undefined
      }
    >
      {line.text === '' ? ' ' : line.text}
    </div>
  )
}

/** The logo from its 1-bit raster: exactly the dots the printer gets. */
function Logo({ logo }: { logo: LogoRaster }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    element.width = logo.widthDots
    element.height = logo.heightDots
    element
      .getContext('2d')
      ?.putImageData(new ImageData(rasterToRgba(logo) as Uint8ClampedArray<ArrayBuffer>, logo.widthDots, logo.heightDots), 0, 0)
  }, [logo])
  return (
    <div className="flex justify-center pb-[0.5em]">
      <canvas ref={canvas} aria-hidden="true" style={{ width: `${(logo.widthDots / PAPER_DOTS) * 100}%`, imageRendering: 'pixelated' }} />
    </div>
  )
}
