'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ImageUp, Trash2 } from 'lucide-react'
import { ApiError, call as callApi, input, primary, secondary } from '@/components/manage/manage-ui'
import { LOGO_WIDTHS, logoSize, rasterToRgba, toLogoRaster, type LogoRaster } from '@/lib/logo-raster'
import type { Settings } from '@/server/services/settings.service'
import { cn } from '@/lib/utils'

/**
 * Manage → Settings (spec-restaurant-settings): what the bill prints and the
 * rates new bills use. The logo is converted HERE, in the browser, to the
 * printer's black-and-white raster, and the preview is drawn from that raster —
 * exactly what will print.
 */

const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/settings')
const KEY = ['manage-settings'] as const
const MAX_FILE_BYTES = 5 * 1024 * 1024
const label = 'text-fs-14 font-semibold text-slate-600 night:text-night-second'
const hint = 'text-fs-12 text-slate-500 night:text-night-muted'

type Form = {
  restaurantName: string
  receiptHeader: string
  receiptFooter: string
  receiptQrUrl: string
  receiptQrCaption: string
  receiptLogo: LogoRaster | null
  servicePercent: string
  taxPercent: string
  businessDayStartHour: number
}

const formOf = (s: Settings): Form => ({
  restaurantName: s.restaurantName,
  receiptHeader: s.receiptHeader,
  receiptFooter: s.receiptFooter,
  receiptQrUrl: s.receiptQrUrl,
  receiptQrCaption: s.receiptQrCaption,
  receiptLogo: s.receiptLogo,
  servicePercent: String(s.serviceChargeBp / 100),
  taxPercent: String(s.taxRatePercent),
  businessDayStartHour: s.businessDayStartHour,
})

export function SettingsEditor() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => ((await call('GET', '/api/manage/settings')) as { data: Settings }).data,
    // A focus refetch would remount the form and drop unsaved edits; this page
    // reloads only after a save, or when the server says it is stale.
    refetchOnWindowFocus: false,
  })
  const [savedVersion, setSavedVersion] = useState<string | null>(null)
  // Kept here: the stale reload remounts the form, which would lose its own note.
  const [staleNote, setStaleNote] = useState<string | null>(null)
  if (isLoading || !data) {
    return error ? (
      <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">Could not load the settings.</p>
    ) : (
      <p className="text-fs-14 text-slate-600 night:text-night-second">Loading the settings…</p>
    )
  }
  // Keyed by the version: after a save or a reload the form starts from the
  // server's values again.
  return (
    <SettingsForm
      key={data.updatedAt}
      data={data}
      justSaved={savedVersion === data.updatedAt}
      staleNote={staleNote}
      onSaved={(saved) => {
        setStaleNote(null)
        setSavedVersion(saved.updatedAt)
        queryClient.setQueryData(KEY, saved)
      }}
      onStale={(message) => {
        setStaleNote(message)
        void queryClient.invalidateQueries({ queryKey: KEY })
      }}
    />
  )
}

function SettingsForm({
  data,
  justSaved,
  staleNote,
  onSaved,
  onStale,
}: {
  data: Settings
  justSaved: boolean
  staleNote: string | null
  onSaved: (saved: Settings) => void
  onStale: (message: string) => void
}) {
  const [form, setForm] = useState<Form>(() => formOf(data))
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    justSaved
      ? { ok: true, text: 'Saved. The next bill uses these settings.' }
      : staleNote
        ? { ok: false, text: `${staleNote} Make your changes again.` }
        : null,
  )

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setNote(null)
  }

  async function save() {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(form.servicePercent.trim())) {
      setNote({ ok: false, text: 'Service charge: a percent like 10 or 2.5' })
      return
    }
    if (!/^\d{1,2}$/.test(form.taxPercent.trim())) {
      setNote({ ok: false, text: 'Tax: a whole percent like 0 or 5' })
      return
    }
    const service = Number(form.servicePercent)
    const tax = Number(form.taxPercent)
    setSaving(true)
    setNote(null)
    try {
      const response = (await call('PUT', '/api/manage/settings', {
        restaurantName: form.restaurantName,
        receiptHeader: form.receiptHeader,
        receiptFooter: form.receiptFooter,
        receiptQrUrl: form.receiptQrUrl,
        receiptQrCaption: form.receiptQrCaption,
        receiptLogo: form.receiptLogo,
        serviceChargeBp: Math.round(service * 100),
        taxRatePercent: tax,
        businessDayStartHour: form.businessDayStartHour,
        updatedAt: data.updatedAt,
      })) as { data: Settings }
      onSaved(response.data)
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : ''
      if (code === 'STALE') return onStale(failure instanceof Error ? failure.message : 'Someone else changed the settings.')
      setNote({ ok: false, text: failure instanceof Error ? failure.message : 'Could not save the settings' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">Settings</h1>
        <div className="flex items-center gap-sp-3">
          {note ? (
            <span role={note.ok ? 'status' : 'alert'} className={cn('text-fs-14 font-semibold', note.ok ? 'text-slate-600 night:text-night-second' : 'text-red-700 night:text-red-400')}>
              {note.text}
            </span>
          ) : null}
          <button type="button" className={cn(primary, 'disabled:opacity-50')} disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      <Card title="Bill">
        <Field label="Restaurant name" hint="Printed large at the top of every bill.">
          <input className={input} maxLength={60} value={form.restaurantName} onChange={(e) => set('restaurantName', e.target.value)} />
        </Field>
        <Field label="Header lines" hint="Under the name: address, phone. Up to 6 lines of 48 characters.">
          <textarea className={cn(input, 'h-auto min-h-24 py-sp-2')} rows={4} value={form.receiptHeader} onChange={(e) => set('receiptHeader', e.target.value)} />
        </Field>
        <Field label="Footer lines" hint="At the end: Instagram, website, a thank-you. Up to 6 lines of 48 characters.">
          <textarea className={cn(input, 'h-auto min-h-24 py-sp-2')} rows={4} value={form.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} />
        </Field>
      </Card>

      <Card title="Logo">
        <LogoField logo={form.receiptLogo} onChange={(logo) => set('receiptLogo', logo)} />
      </Card>

      <Card title="Review QR">
        <Field label="Link" hint="Printed as a QR code at the foot of the bill, e.g. your Google review page. Empty prints no QR.">
          <input className={input} inputMode="url" placeholder="https://" value={form.receiptQrUrl} onChange={(e) => set('receiptQrUrl', e.target.value)} />
        </Field>
        <Field label="Caption" hint="The line under the QR.">
          <input className={input} maxLength={48} value={form.receiptQrCaption} onChange={(e) => set('receiptQrCaption', e.target.value)} />
        </Field>
      </Card>

      <Card title="Money">
        <div className="grid gap-sp-3 sm:grid-cols-2">
          <Field label="Service charge (%)" hint="On table orders. e.g. 10 or 2.5. New bills only.">
            <input className={input} inputMode="decimal" value={form.servicePercent} onChange={(e) => set('servicePercent', e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <Field label="Tax (%)" hint="A whole percent. New bills only.">
            <input className={input} inputMode="numeric" value={form.taxPercent} onChange={(e) => set('taxPercent', e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      </Card>

      <Card title="Business day">
        <Field label="The day turns over at" hint="Orders after midnight count on the evening before until this hour. Applies to new orders — change it outside service hours.">
          <select className={input} value={form.businessDayStartHour} onChange={(e) => set('businessDayStartHour', Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={hour}>
                {String(hour).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </Field>
      </Card>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-sp-3 rounded-panel bg-white p-sp-4 night:bg-night-card">
      <h2 className="text-fs-16 font-extrabold text-slate-900 night:text-night-text">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label: text, hint: help, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-sp-1">
      <span className={label}>{text}</span>
      {children}
      {help ? <span className={hint}>{help}</span> : null}
    </label>
  )
}

/**
 * Pick an image → draw it at the chosen width → threshold to 1 bit → preview
 * from the raster. Re-converts from the kept image when width or darkness
 * changes, so the owner can tune it before saving.
 */
function LogoField({ logo, onChange }: { logo: LogoRaster | null; onChange: (logo: LogoRaster | null) => void }) {
  const preview = useRef<HTMLCanvasElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [width, setWidth] = useState<number>(logo?.widthDots && (LOGO_WIDTHS as readonly number[]).includes(logo.widthDots) ? logo.widthDots : 288)
  const [threshold, setThreshold] = useState(128)
  const [problem, setProblem] = useState<string | null>(null)
  // The latest pick wins, even if an earlier, larger image finishes loading last.
  const picks = useRef(0)

  // Draw the raster that will be saved (and printed).
  useEffect(() => {
    const canvas = preview.current
    if (!canvas || !logo) return
    canvas.width = logo.widthDots
    canvas.height = logo.heightDots
    canvas.getContext('2d')?.putImageData(new ImageData(rasterToRgba(logo) as Uint8ClampedArray<ArrayBuffer>, logo.widthDots, logo.heightDots), 0, 0)
  }, [logo])

  // Re-convert when the picked image, the size or the darkness changes.
  useEffect(() => {
    if (!image) return
    const size = logoSize(image.naturalWidth, image.naturalHeight, width)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(image, 0, 0, size.width, size.height)
    const pixels = context.getImageData(0, 0, size.width, size.height).data
    onChange(toLogoRaster(pixels, size.width, size.height, threshold))
    // `onChange` is a fresh closure each render; the inputs above are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, width, threshold])

  function pick(file: File | undefined) {
    setProblem(null)
    if (!file) return
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setProblem('Choose a PNG or JPG image')
    if (file.size > MAX_FILE_BYTES) return setProblem('That image is over 5 MB. Choose a smaller one.')
    const url = URL.createObjectURL(file)
    const img = new Image()
    const pickNumber = ++picks.current
    img.onload = () => {
      URL.revokeObjectURL(url)
      if (pickNumber !== picks.current) return
      if (img.naturalWidth < 1 || img.naturalHeight < 1) return setProblem('That image could not be read')
      setImage(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      setProblem('That image could not be read')
    }
    img.src = url
  }

  return (
    <div className="flex flex-col gap-sp-3">
      <p className={hint}>Printed above the name, in black and white. The preview is exactly what the printer prints.</p>
      <div className="flex min-h-24 items-center justify-center rounded-control border border-dashed border-slate-300 bg-white p-sp-3 night:border-night-hairline">
        {logo ? (
          // The paper is white in dark mode too.
          <canvas ref={preview} className="max-w-full" style={{ imageRendering: 'pixelated', width: logo.widthDots / 2 }} aria-label="Logo preview" />
        ) : (
          <span className="text-fs-14 text-slate-500">No logo</span>
        )}
      </div>
      {problem ? <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">{problem}</p> : null}
      <div className="flex flex-wrap items-center gap-sp-2">
        <input ref={fileInput} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => {
            pick(e.target.files?.[0])
            // Cleared, so picking the same file again still fires.
            e.target.value = ''
          }} />
        <button type="button" className={secondary} onClick={() => fileInput.current?.click()}>
          <ImageUp className="size-4" aria-hidden="true" /> {logo ? 'Change logo' : 'Upload logo'}
        </button>
        {logo ? (
          <button
            type="button"
            className={secondary}
            onClick={() => {
              setImage(null)
              onChange(null)
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" /> Remove logo
          </button>
        ) : null}
      </div>
      {image ? (
        <div className="grid gap-sp-3 sm:grid-cols-2">
          <Field label="Size">
            <select className={input} value={width} onChange={(e) => setWidth(Number(e.target.value))}>
              <option value={192}>Small (24 mm)</option>
              <option value={288}>Medium (36 mm)</option>
              <option value={384}>Large (48 mm)</option>
            </select>
          </Field>
          <Field label="Darkness" hint="Slide right if parts are missing, left if it is too heavy.">
            <input type="range" min={40} max={220} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </Field>
        </div>
      ) : null}
      <p className={hint}>Saved with the Save button above.</p>
    </div>
  )
}
