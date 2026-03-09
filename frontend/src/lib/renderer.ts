// ─── Renderer utilities: types, dimension helpers, zoom, change detection ───

import {
  CHANGE_DETECT_SAMPLE_SIZE,
  DOM_COLOR_SAMPLE_SIZE,
  DOM_COLOR_AREA_THRESH,
  LAYER_ALPHA,
} from './constants'

export const DPR = window.devicePixelRatio || 1

// ─── Types ───

/** Single image or array of images to composite (source-over). */
export type ImageSource = CanvasImageSource | CanvasImageSource[]

// ─── Pixel helpers ───

function singleSourceWidth(src: CanvasImageSource): number {
  if (src instanceof HTMLImageElement) return src.naturalWidth || src.width
  if (src instanceof HTMLCanvasElement) return src.width
  return 0
}

function singleSourceHeight(src: CanvasImageSource): number {
  if (src instanceof HTMLImageElement) return src.naturalHeight || src.height
  if (src instanceof HTMLCanvasElement) return src.height
  return 0
}

export function getSourceWidth(src: ImageSource | null): number {
  if (!src) return 0
  if (Array.isArray(src)) {
    let max = 0
    for (const s of src) max = Math.max(max, singleSourceWidth(s))
    return max
  }
  return singleSourceWidth(src)
}

export function getSourceHeight(src: ImageSource | null): number {
  if (!src) return 0
  if (Array.isArray(src)) {
    let max = 0
    for (const s of src) max = Math.max(max, singleSourceHeight(s))
    return max
  }
  return singleSourceHeight(src)
}

export function getNaturalDimensions(imgOld: ImageSource, imgNew: ImageSource) {
  const natW = Math.max(getSourceWidth(imgOld), getSourceWidth(imgNew))
  const natH = Math.max(getSourceHeight(imgOld), getSourceHeight(imgNew))
  return { natW, natH }
}

// Set CSS display size (zoom via CSS transform, instant)
export function applyZoom(cvs: HTMLCanvasElement, natW: number, natH: number, zoom: number) {
  const scale = zoom / 100
  cvs.style.width = Math.round(natW * scale) + 'px'
  cvs.style.height = Math.round(natH * scale) + 'px'
}

// ─── Change detection (for tab dots) ───

// Nested WeakMap: imgOld → (imgNew → diffMap). Keys are image references,
// so entries are automatically GC'd when images are no longer referenced.
const diffMapCache = new WeakMap<CanvasImageSource, WeakMap<CanvasImageSource, Uint8Array>>()

export function detectChanges(
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  thresh: number,
): boolean {
  // Cache lookup — diff map is keyed by image reference pair
  let inner = diffMapCache.get(imgOld)
  let diffMap = inner?.get(imgNew)

  if (!diffMap) {
    // Cache miss — do the expensive Canvas/getImageData work once
    const size = CHANGE_DETECT_SAMPLE_SIZE
    const w = size
    const baseW = Math.max(singleSourceWidth(imgOld), singleSourceWidth(imgNew)) || 1
    const baseH = Math.max(singleSourceHeight(imgOld), singleSourceHeight(imgNew)) || 1
    const aspect = baseH / baseW
    const h = Math.round(size * aspect) || size

    const oc1 = new OffscreenCanvas(w, h)
    const oc2 = new OffscreenCanvas(w, h)
    const x1 = oc1.getContext('2d')!
    const x2 = oc2.getContext('2d')!
    x1.drawImage(imgOld, 0, 0, w, h)
    x2.drawImage(imgNew, 0, 0, w, h)

    const d1 = x1.getImageData(0, 0, w, h).data
    const d2 = x2.getImageData(0, 0, w, h).data
    const pixelCount = w * h
    diffMap = new Uint8Array(pixelCount)

    // Uint32Array fast path: compare 4 bytes (RGBA) at once
    const u1 = new Uint32Array(d1.buffer, d1.byteOffset, pixelCount)
    const u2 = new Uint32Array(d2.buffer, d2.byteOffset, pixelCount)

    for (let i = 0; i < pixelCount; i++) {
      if (u1[i] === u2[i]) continue // identical pixel — diffMap[i] stays 0
      const off = i * 4
      diffMap[i] = Math.max(
        Math.abs(d1[off] - d2[off]),
        Math.abs(d1[off + 1] - d2[off + 1]),
        Math.abs(d1[off + 2] - d2[off + 2]),
        Math.abs(d1[off + 3] - d2[off + 3]),
      )
    }

    if (!inner) {
      inner = new WeakMap()
      diffMapCache.set(imgOld, inner)
    }
    inner.set(imgNew, diffMap)
  }

  // Scan diff map against threshold
  for (let i = 0; i < diffMap.length; i++) {
    if (diffMap[i] > thresh) return true
  }
  return false
}

// ─── Dominant colour detection (fill-area background) ───
//
// Detects the fill colour that covers a large portion of an image (e.g. copper
// layer fills in PCB renders). Returns a normalised [r, g, b] triple (0-1) if
// a colour occupies ≥ DOM_COLOR_AREA_THRESH of opaque pixels, else null.
//
// Used by the diff/sideAnnotated shaders to treat such pixels as "background"
// so that fill-area differences don't drown out real content changes.

export type DominantColor = [number, number, number] | null

const domColorCache = new WeakMap<CanvasImageSource | CanvasImageSource[], DominantColor>()

export function detectDominantColor(src: ImageSource): DominantColor {
  // Cache lookup — keyed by ImageSource reference (same GC semantics as diffMapCache)
  const key = src as CanvasImageSource | CanvasImageSource[]
  const cached = domColorCache.get(key)
  if (cached !== undefined) return cached

  // Rasterize to small canvas
  const arr = Array.isArray(src) ? src : [src]
  const baseW = arr.reduce((m, s) => Math.max(m, singleSourceWidth(s)), 0) || 1
  const baseH = arr.reduce((m, s) => Math.max(m, singleSourceHeight(s)), 0) || 1
  const aspect = baseH / baseW
  const w = DOM_COLOR_SAMPLE_SIZE
  const h = Math.round(w * aspect) || w

  const oc = new OffscreenCanvas(w, h)
  const ctx = oc.getContext('2d')!
  const useAlpha = arr.length > 1
  for (const img of arr) {
    if (useAlpha) ctx.globalAlpha = LAYER_ALPHA
    ctx.drawImage(img, 0, 0, w, h)
  }

  const data = ctx.getImageData(0, 0, w, h).data
  const pixelCount = w * h

  // Build quantized colour histogram (3-bit per channel → 512 buckets).
  // Wider buckets (32 colour levels each) avoid boundary-splitting without
  // needing neighbourhood merging, keeping the logic simple and correct.
  const SHIFT = 5
  const BUCKETS = 1 << (3 * (8 - SHIFT)) // 512
  const counts = new Uint32Array(BUCKETS)
  const sumR = new Float64Array(BUCKETS)
  const sumG = new Float64Array(BUCKETS)
  const sumB = new Float64Array(BUCKETS)
  let opaqueCount = 0

  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4
    if (data[off + 3] < 2) continue // skip transparent
    opaqueCount++

    const r = data[off]
    const g = data[off + 1]
    const b = data[off + 2]
    const qr = r >> SHIFT, qg = g >> SHIFT, qb = b >> SHIFT
    const bucket = (qr << (2 * (8 - SHIFT))) | (qg << (8 - SHIFT)) | qb
    counts[bucket]++
    sumR[bucket] += r
    sumG[bucket] += g
    sumB[bucket] += b
  }

  if (opaqueCount === 0) {
    domColorCache.set(key, null)
    return null
  }

  // Find the largest bucket
  let maxBucket = 0
  let maxCount = 0
  for (let i = 0; i < BUCKETS; i++) {
    if (counts[i] > maxCount) {
      maxCount = counts[i]
      maxBucket = i
    }
  }

  let result: DominantColor = null
  if (maxCount / opaqueCount >= DOM_COLOR_AREA_THRESH) {
    result = [
      sumR[maxBucket] / maxCount / 255,
      sumG[maxBucket] / maxCount / 255,
      sumB[maxBucket] / maxCount / 255,
    ]
  }

  domColorCache.set(key, result)
  return result
  
}
