// ─── Image loading with cache + placeholder generation + layer array loading ───

import type { LayerPair } from '../types'
import type { ImageSource } from '../lib/renderer'
import { getSourceWidth, getSourceHeight } from '../lib/renderer'

const imgCache = new Map<string, HTMLImageElement>()

export function clearImgCache() {
  imgCache.clear()
}

export function loadImg(src: string): Promise<HTMLImageElement> {
  const cached = imgCache.get(src)
  if (cached) return Promise.resolve(cached)

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      imgCache.set(src, img)
      resolve(img)
    }
    img.onerror = reject
    img.src = src
  })
}

function createPlaceholder(refImg: CanvasImageSource | null): HTMLCanvasElement {
  const refW = getSourceWidth(refImg) || 100
  const refH = getSourceHeight(refImg) || 100
  const oc = document.createElement('canvas')
  oc.width = refW
  oc.height = refH
  return oc
}

export async function loadFilePair(
  oldSvg: string | null,
  newSvg: string | null,
): Promise<{ imgOld: CanvasImageSource; imgNew: CanvasImageSource }> {
  let imgOld: CanvasImageSource | null = oldSvg ? await loadImg(oldSvg) : null
  let imgNew: CanvasImageSource | null = newSvg ? await loadImg(newSvg) : null
  if (!imgOld && imgNew) imgOld = createPlaceholder(imgNew)
  if (!imgNew && imgOld) imgNew = createPlaceholder(imgOld)
  if (!imgOld && !imgNew) {
    imgOld = createPlaceholder(null)
    imgNew = createPlaceholder(null)
  }
  return { imgOld: imgOld!, imgNew: imgNew! }
}

/**
 * Load multiple layer SVGs and return arrays of individual images.
 *
 * Unlike pre-compositing onto an OffscreenCanvas, returning raw
 * SVG-backed HTMLImageElements preserves vector quality — the browser
 * re-rasterises each SVG at whatever target resolution drawImage requests.
 */
export async function loadLayerImageArrays(
  pairs: LayerPair[],
): Promise<{ imgOld: ImageSource; imgNew: ImageSource }> {
  if (pairs.length === 0) {
    const ph = createPlaceholder(null)
    return { imgOld: ph, imgNew: ph }
  }

  // Load all layer images in parallel
  const loaded = await Promise.all(
    pairs.map(async (p) => ({
      old: p.oldSvg ? await loadImg(p.oldSvg) : null,
      new: p.newSvg ? await loadImg(p.newSvg) : null,
    })),
  )

  const oldImgs = loaded.map((l) => l.old).filter(Boolean) as CanvasImageSource[]
  const newImgs = loaded.map((l) => l.new).filter(Boolean) as CanvasImageSource[]

  // If no images on a side, use a placeholder matching the other side
  const anyImg = oldImgs[0] || newImgs[0] || null
  const imgOld: ImageSource = oldImgs.length > 0 ? oldImgs : createPlaceholder(anyImg)
  const imgNew: ImageSource = newImgs.length > 0 ? newImgs : createPlaceholder(anyImg)

  return { imgOld, imgNew }
}
