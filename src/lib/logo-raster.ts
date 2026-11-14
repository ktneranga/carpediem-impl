/**
 * Turns an image into the receipt printer's 1-bit logo (spec-restaurant-settings).
 *
 * Pure: pixels in, raster out. It runs in the browser on a `<canvas>`'s pixels,
 * so the POS server needs no image library — the reason `tenant_config.
 * receipt_logo` stores a ready raster. The format is what `escpos.rasterImage`
 * prints: `data` is base64, one bit per dot, rows of `widthDots / 8` bytes, MSB
 * left, 1 = ink. Imports nothing, so the verify script and the browser share it.
 */

export type LogoRaster = { widthDots: number; heightDots: number; data: string }

/** The printer's limits (`escpos.rasterImage`). */
export const MAX_LOGO_WIDTH = 576
export const MAX_LOGO_HEIGHT = 600
/** The widths offered: small, medium, large (80mm paper is 576 dots). */
export const LOGO_WIDTHS = [192, 288, 384] as const

/**
 * The size to draw an image of `width` × `height` pixels at, for a logo
 * `targetWidth` dots wide: width a multiple of 8, height capped at 600 (the
 * width shrinks with it to keep the shape).
 */
export function logoSize(width: number, height: number, targetWidth: number): { width: number; height: number } {
  let w = Math.min(Math.max(8, Math.floor(targetWidth / 8) * 8), MAX_LOGO_WIDTH)
  let h = Math.max(1, Math.round((height / width) * w))
  if (h > MAX_LOGO_HEIGHT) {
    w = Math.max(8, Math.floor(((width / height) * MAX_LOGO_HEIGHT) / 8) * 8)
    h = Math.min(MAX_LOGO_HEIGHT, Math.max(1, Math.round((height / width) * w)))
  }
  return { width: w, height: h }
}

/**
 * RGBA pixels (already drawn at the logo size) → raster. Transparent counts as
 * paper (white). A pixel prints when its lightness is below `threshold`
 * (0–255; 128 is the middle — higher prints more).
 */
export function toLogoRaster(rgba: ArrayLike<number>, width: number, height: number, threshold = 128): LogoRaster {
  if (width % 8 !== 0 || width <= 0 || width > MAX_LOGO_WIDTH) throw new Error('width must be a multiple of 8, at most 576')
  if (height <= 0 || height > MAX_LOGO_HEIGHT) throw new Error('height must be 1 to 600')
  const rowBytes = width / 8
  const bytes = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const alpha = rgba[i + 3]! / 255
      // Composite on white, then luminance (ITU-R BT.601).
      const r = rgba[i]! * alpha + 255 * (1 - alpha)
      const g = rgba[i + 1]! * alpha + 255 * (1 - alpha)
      const b = rgba[i + 2]! * alpha + 255 * (1 - alpha)
      const light = 0.299 * r + 0.587 * g + 0.114 * b
      if (light < threshold) bytes[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7)
    }
  }
  return { widthDots: width, heightDots: height, data: toBase64(bytes) }
}

/** The raster as RGBA pixels (black ink on white), for a preview canvas. */
export function rasterToRgba(logo: LogoRaster): Uint8ClampedArray {
  const bytes = fromBase64(logo.data)
  const rowBytes = logo.widthDots / 8
  const out = new Uint8ClampedArray(logo.widthDots * logo.heightDots * 4)
  for (let y = 0; y < logo.heightDots; y += 1) {
    for (let x = 0; x < logo.widthDots; x += 1) {
      const ink = (bytes[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7))) !== 0
      const i = (y * logo.widthDots + x) * 4
      const v = ink ? 0 : 255
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      out[i + 3] = 255
    }
  }
  return out
}

// Base64 without Buffer (the browser) or btoa (Node before 16): a tiny codec.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : '='
  }
  return out
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (ALPHABET.indexOf(clean[i]!) << 18) |
      (ALPHABET.indexOf(clean[i + 1] ?? 'A') << 12) |
      ((clean[i + 2] ? ALPHABET.indexOf(clean[i + 2]!) : 0) << 6) |
      (clean[i + 3] ? ALPHABET.indexOf(clean[i + 3]!) : 0)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}
