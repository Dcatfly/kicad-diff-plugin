// ─── Image loading with cache + placeholder generation ───

import { getSourceWidth, getSourceHeight } from '../lib/renderer'

const imgCache = new Map<string, HTMLImageElement>()

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
  const octx = oc.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, oc.width, oc.height)
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
