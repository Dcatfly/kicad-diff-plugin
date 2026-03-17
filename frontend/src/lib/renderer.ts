// ─── Renderer utilities: types, dimension helpers, zoom, change detection ───

import {
  CHANGE_DETECT_SAMPLE_SIZE,
  DOM_COLOR_SAMPLE_SIZE,
  DOM_COLOR_AREA_THRESH,
  LAYER_ALPHA,
  AUTO_FIT_PADDING_RATIO,
  ZOOM_MIN,
  ZOOM_MAX,
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

// ─── Shared diff map computation (reused by detectChanges + computeDiffBounds) ───

interface DiffMapEntry { map: Uint8Array; w: number; h: number }

// Nested WeakMap: imgOld → (imgNew → entry). Keys are image references,
// so entries are automatically GC'd when images are no longer referenced.
const diffMapCache = new WeakMap<object, WeakMap<object, DiffMapEntry>>()

/**
 * Get (or compute + cache) a per-pixel max-channel diff map for an image pair.
 * Always samples at CHANGE_DETECT_SAMPLE_SIZE (128px width).
 */
function getDiffMap(imgOld: ImageSource, imgNew: ImageSource): DiffMapEntry {
  const keyOld = imgOld as object
  const keyNew = imgNew as object

  let inner = diffMapCache.get(keyOld)
  const cached = inner?.get(keyNew)
  if (cached) return cached

  const size = CHANGE_DETECT_SAMPLE_SIZE
  const w = size
  const baseW = Math.max(getSourceWidth(imgOld), getSourceWidth(imgNew)) || 1
  const baseH = Math.max(getSourceHeight(imgOld), getSourceHeight(imgNew)) || 1
  const h = Math.round(size * (baseH / baseW)) || size

  // Rasterize both sides to small canvases
  const oc1 = new OffscreenCanvas(w, h)
  const oc2 = new OffscreenCanvas(w, h)
  const ctx1 = oc1.getContext('2d')!
  const ctx2 = oc2.getContext('2d')!
  ctx1.drawImage(imgOld as CanvasImageSource, 0, 0, w, h)
  ctx2.drawImage(imgNew as CanvasImageSource, 0, 0, w, h)

  const d1 = ctx1.getImageData(0, 0, w, h).data
  const d2 = ctx2.getImageData(0, 0, w, h).data
  const pixelCount = w * h
  const map = new Uint8Array(pixelCount)

  // Uint32Array fast path: compare 4 bytes (RGBA) at once
  const u1 = new Uint32Array(d1.buffer, d1.byteOffset, pixelCount)
  const u2 = new Uint32Array(d2.buffer, d2.byteOffset, pixelCount)

  for (let i = 0; i < pixelCount; i++) {
    if (u1[i] === u2[i]) continue
    const off = i * 4
    map[i] = Math.max(
      Math.abs(d1[off] - d2[off]),
      Math.abs(d1[off + 1] - d2[off + 1]),
      Math.abs(d1[off + 2] - d2[off + 2]),
      Math.abs(d1[off + 3] - d2[off + 3]),
    )
  }

  if (!inner) {
    inner = new WeakMap()
    diffMapCache.set(keyOld, inner)
  }
  const entry = { map, w, h }
  inner.set(keyNew, entry)
  return entry
}

// ─── Change detection (for tab dots) ───

export function detectChanges(
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  thresh: number,
): boolean {
  const { map } = getDiffMap(imgOld, imgNew)
  for (let i = 0; i < map.length; i++) {
    if (map[i] > thresh) return true
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

// ─── Auto-fit to diff region ───

export interface DiffBounds {
  x0: number; y0: number; x1: number; y1: number // normalised [0,1]
  hasDiff: boolean
}

export interface AutoFitResult {
  zoom: number
  pan: { x: number; y: number }
}

/**
 * Scan a diffMap and expand a normalised [0,1] bounding box in-place.
 *
 * @param map    Per-pixel max-channel diff (0-255), flat row-major array of w×h pixels
 * @param w, h   DiffMap dimensions in pixels
 * @param thresh  Pixels with diff <= thresh are ignored
 * @param box    Accumulated bounding box (normalised). Caller initialises to
 *               {minX:1, minY:1, maxX:0, maxY:0}; may be expanded across
 *               multiple calls (e.g. one per PCB layer).
 *
 * For each changed pixel, we use its left/top edge (x/w, y/h) to shrink min*
 * and its right/bottom edge ((x+1)/w, (y+1)/h) to grow max*, so the bounding
 * box covers the full pixel area rather than just pixel centres.
 */
function expandBounds(
  map: Uint8Array, w: number, h: number, thresh: number,
  box: { minX: number; minY: number; maxX: number; maxY: number },
) {
  for (let i = 0; i < map.length; i++) {
    if (map[i] <= thresh) continue
    // Convert flat index → pixel column/row, then normalise to [0,1]
    const px = i % w                       // pixel column
    const py = (i - px) / w                // pixel row (= Math.floor(i / w))
    const x = px / w                       // normalised left edge
    const y = py / h                       // normalised top edge
    const x1 = (px + 1) / w               // normalised right edge
    const y1 = (py + 1) / h               // normalised bottom edge
    if (x < box.minX) box.minX = x
    if (x1 > box.maxX) box.maxX = x1
    if (y < box.minY) box.minY = y
    if (y1 > box.maxY) box.maxY = y1
  }
}

/**
 * Compute the bounding box of all changed pixels between old and new images.
 * Compares each layer pair independently at CHANGE_DETECT_SAMPLE_SIZE (128px),
 * avoiding alpha compositing signal dilution and reusing detectChanges cache.
 */
export function computeDiffBounds(
  imgOld: ImageSource,
  imgNew: ImageSource,
  thresh: number,
): DiffBounds {
  const box = { minX: 1, minY: 1, maxX: 0, maxY: 0 }

  // For multi-layer PCB: compare each layer pair independently (no alpha
  // compositing). For single images: compare directly. Both use 128px and
  // reuse the detectChanges cache.
  const arrOld = Array.isArray(imgOld) ? imgOld : [imgOld]
  const arrNew = Array.isArray(imgNew) ? imgNew : [imgNew]
  const count = Math.min(arrOld.length, arrNew.length)
  for (let l = 0; l < count; l++) {
    const { map, w, h } = getDiffMap(arrOld[l], arrNew[l])
    expandBounds(map, w, h, thresh, box)
  }

  if (box.maxX <= box.minX) {
    return { x0: 0, y0: 0, x1: 1, y1: 1, hasDiff: false }
  }

  return { x0: box.minX, y0: box.minY, x1: box.maxX, y1: box.maxY, hasDiff: true }
}

/**
 * Compute zoom level and pan offset to fit a diff bounding box into the viewport.
 * When no diff is detected, fits the entire image into the viewport.
 */
export function computeAutoFit(
  bounds: DiffBounds,
  natW: number,
  natH: number,
  containerW: number,
  containerH: number,
): AutoFitResult {
  if (!bounds.hasDiff) {
    // Fit entire image
    const fitScale = Math.min(containerW / natW, containerH / natH)
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(fitScale * 100)))
    const actualScale = zoom / 100
    return {
      zoom,
      pan: {
        x: (natW * actualScale - containerW) / 2,
        y: (natH * actualScale - containerH) / 2,
      },
    }
  }

  // Diff region in natural pixel coordinates
  const diffX = bounds.x0 * natW
  const diffY = bounds.y0 * natH
  const diffW = (bounds.x1 - bounds.x0) * natW
  const diffH = (bounds.y1 - bounds.y0) * natH
  const diffCenterX = diffX + diffW / 2
  const diffCenterY = diffY + diffH / 2

  // Effective viewport after padding
  const effectiveW = containerW * (1 - 2 * AUTO_FIT_PADDING_RATIO)
  const effectiveH = containerH * (1 - 2 * AUTO_FIT_PADDING_RATIO)

  const fitScale = Math.min(effectiveW / diffW, effectiveH / diffH)
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(fitScale * 100)))
  const actualScale = zoom / 100

  return {
    zoom,
    pan: {
      x: diffCenterX * actualScale - containerW / 2,
      y: diffCenterY * actualScale - containerH / 2,
    },
  }
}
