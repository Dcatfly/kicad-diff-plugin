// ─── Pure rendering functions: pixel-level diff, overlay, side-by-side ───

const DPR = window.devicePixelRatio || 1

// ─── Pixel helpers ───

export function getSourceWidth(src: CanvasImageSource | null): number {
  if (!src) return 0
  if (src instanceof HTMLImageElement) return src.naturalWidth || src.width
  if (src instanceof HTMLCanvasElement) return src.width
  return 0
}

export function getSourceHeight(src: CanvasImageSource | null): number {
  if (!src) return 0
  if (src instanceof HTMLImageElement) return src.naturalHeight || src.height
  if (src instanceof HTMLCanvasElement) return src.height
  return 0
}

function getNaturalDimensions(
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
) {
  const natW = Math.max(getSourceWidth(imgOld), getSourceWidth(imgNew))
  const natH = Math.max(getSourceHeight(imgOld), getSourceHeight(imgNew))
  return { natW, natH }
}

// Set canvas backing buffer (physical pixels) without touching CSS
function setCanvasBacking(cvs: HTMLCanvasElement, pw: number, ph: number) {
  cvs.width = pw
  cvs.height = ph
}

// Set CSS display size (zoom via CSS transform, instant)
export function applyZoom(cvs: HTMLCanvasElement, natW: number, natH: number, zoom: number) {
  const scale = zoom / 100
  cvs.style.width = Math.round(natW * scale) + 'px'
  cvs.style.height = Math.round(natH * scale) + 'px'
}

function rasterize(img: CanvasImageSource, pw: number, ph: number): ImageData {
  const oc = new OffscreenCanvas(pw, ph)
  const octx = oc.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, pw, ph)
  octx.drawImage(img, 0, 0, pw, ph)
  return octx.getImageData(0, 0, pw, ph)
}

function rasterizeRegion(
  img: CanvasImageSource,
  sx: number, sy: number, sw: number, sh: number,
  pw: number, ph: number,
): ImageData {
  const oc = new OffscreenCanvas(pw, ph)
  const octx = oc.getContext('2d')!
  // No fill — areas outside the source image remain transparent (alpha=0)
  octx.drawImage(img, sx, sy, sw, sh, 0, 0, pw, ph)
  return octx.getImageData(0, 0, pw, ph)
}

function buildDiffMask(
  oldP: Uint8ClampedArray,
  newP: Uint8ClampedArray,
  len: number,
  thresh: number,
): Uint8Array {
  const mask = new Uint8Array(len)
  for (let p = 0; p < len; p++) {
    const i = p << 2
    const diff = Math.max(
      Math.abs(oldP[i] - newP[i]),
      Math.abs(oldP[i + 1] - newP[i + 1]),
      Math.abs(oldP[i + 2] - newP[i + 2]),
    )
    if (diff > thresh) mask[p] = 1
  }
  return mask
}

function isPaperBlank(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const avg = (r + g + b) / 3
  return max >= 220 && avg >= 215 && max - min <= 26
}

// ─── Shared pixel loops ───

function applyDiffColors(
  oldP: Uint8ClampedArray,
  newP: Uint8ClampedArray,
  mask: Uint8Array,
  fade: number,
  pw: number,
  ph: number,
): ImageData {
  const out = new ImageData(pw, ph)
  const od = out.data
  const fadeAlpha = 1 - fade / 100
  const bgR = 15, bgG = 15, bgB = 35

  for (let p = 0; p < pw * ph; p++) {
    const i = p << 2
    // Both pixels outside image bounds — keep transparent
    if (oldP[i + 3] === 0 && newP[i + 3] === 0) { od[i + 3] = 0; continue }
    const ro = oldP[i], go = oldP[i + 1], bo = oldP[i + 2]
    const rn = newP[i], gn = newP[i + 1], bn = newP[i + 2]
    if (mask[p]) {
      const oldIsBlank = isPaperBlank(ro, go, bo)
      const newIsBlank = isPaperBlank(rn, gn, bn)
      if (oldIsBlank && !newIsBlank) {
        od[i] = Math.round(rn * 0.3)
        od[i + 1] = Math.min(255, Math.round(gn * 0.5 + 120))
        od[i + 2] = Math.round(bn * 0.3)
      } else if (!oldIsBlank && newIsBlank) {
        od[i] = Math.min(255, Math.round(ro * 0.5 + 120))
        od[i + 1] = Math.round(go * 0.3)
        od[i + 2] = Math.round(bo * 0.3)
      } else {
        od[i] = Math.min(255, Math.round(rn * 0.4 + 150))
        od[i + 1] = Math.min(255, Math.round(gn * 0.3 + 100))
        od[i + 2] = Math.round(bn * 0.2)
      }
      od[i + 3] = 255
    } else {
      od[i] = Math.round(rn * fadeAlpha + bgR * (1 - fadeAlpha))
      od[i + 1] = Math.round(gn * fadeAlpha + bgG * (1 - fadeAlpha))
      od[i + 2] = Math.round(bn * fadeAlpha + bgB * (1 - fadeAlpha))
      od[i + 3] = 255
    }
  }
  return out
}

function applySideAnnotatedColors(
  oldP: Uint8ClampedArray,
  newP: Uint8ClampedArray,
  pw: number,
  ph: number,
  isOld: boolean,
  fade: number,
  thresh: number,
): ImageData {
  const fadeAlpha = 1 - fade / 100
  const bgR = 15, bgG = 15, bgB = 35

  const outImg = new ImageData(pw, ph)
  const od = outImg.data
  for (let p = 0; p < pw * ph; p++) {
    const i = p << 2
    // Both pixels outside image bounds — keep transparent
    if (oldP[i + 3] === 0 && newP[i + 3] === 0) { od[i + 3] = 0; continue }
    const ro = oldP[i], go = oldP[i + 1], bo = oldP[i + 2]
    const rn = newP[i], gn = newP[i + 1], bn = newP[i + 2]
    const r = isOld ? ro : rn
    const g = isOld ? go : gn
    const b = isOld ? bo : bn
    const oldBlank = isPaperBlank(ro, go, bo)
    const newBlank = isPaperBlank(rn, gn, bn)
    const diff = Math.max(
      Math.abs(ro - rn),
      Math.abs(go - gn),
      Math.abs(bo - bn),
    )
    const isDirectionalDiff =
      diff > thresh && (isOld ? !oldBlank && newBlank : oldBlank && !newBlank)

    if (isDirectionalDiff) {
      if (isOld) {
        od[i] = Math.min(255, Math.round(r * 0.5 + 120))
        od[i + 1] = Math.round(g * 0.35)
        od[i + 2] = Math.round(b * 0.35)
      } else {
        od[i] = Math.round(r * 0.35)
        od[i + 1] = Math.min(255, Math.round(g * 0.5 + 120))
        od[i + 2] = Math.round(b * 0.35)
      }
      od[i + 3] = 255
    } else {
      od[i] = Math.round(r * fadeAlpha + bgR * (1 - fadeAlpha))
      od[i + 1] = Math.round(g * fadeAlpha + bgG * (1 - fadeAlpha))
      od[i + 2] = Math.round(b * fadeAlpha + bgB * (1 - fadeAlpha))
      od[i + 3] = 255
    }
  }
  return outImg
}

// ─── Diff mode renderer (native resolution) ───

export function renderDiff(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  fade: number,
  thresh: number,
): { natW: number; natH: number } {
  const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
  const pw = Math.round(natW * DPR)
  const ph = Math.round(natH * DPR)
  setCanvasBacking(canvas, pw, ph)

  const dOld = rasterize(imgOld, pw, ph)
  const dNew = rasterize(imgNew, pw, ph)
  const mask = buildDiffMask(dOld.data, dNew.data, pw * ph, thresh)
  const out = applyDiffColors(dOld.data, dNew.data, mask, fade, pw, ph)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(out, 0, 0)
  return { natW, natH }
}

// ─── Overlay mode renderer (native resolution) ───

export function renderOverlay(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  overlay: number,
): { natW: number; natH: number } {
  const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
  const pw = Math.round(natW * DPR)
  const ph = Math.round(natH * DPR)
  setCanvasBacking(canvas, pw, ph)
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, natW, natH)
  ctx.globalAlpha = 1
  ctx.drawImage(imgOld, 0, 0, natW, natH)
  ctx.globalAlpha = overlay / 100
  ctx.drawImage(imgNew, 0, 0, natW, natH)
  ctx.globalAlpha = 1
  return { natW, natH }
}

// ─── Side-by-side mode renderers (native resolution) ───

function renderSideRaw(
  cvs: HTMLCanvasElement,
  cctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  natW: number,
  natH: number,
) {
  const pw = Math.round(natW * DPR)
  const ph = Math.round(natH * DPR)
  setCanvasBacking(cvs, pw, ph)
  cctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  cctx.imageSmoothingEnabled = true
  cctx.imageSmoothingQuality = 'high'
  cctx.fillStyle = '#fff'
  cctx.fillRect(0, 0, natW, natH)
  cctx.drawImage(img, 0, 0, natW, natH)
}

function renderSideAnnotated(
  cvs: HTMLCanvasElement,
  cctx: CanvasRenderingContext2D,
  oldPixels: Uint8ClampedArray,
  newPixels: Uint8ClampedArray,
  pw: number,
  ph: number,
  isOld: boolean,
  fade: number,
  thresh: number,
) {
  setCanvasBacking(cvs, pw, ph)
  const outImg = applySideAnnotatedColors(oldPixels, newPixels, pw, ph, isOld, fade, thresh)
  cctx.setTransform(1, 0, 0, 1, 0, 0)
  cctx.putImageData(outImg, 0, 0)
}

// ─── Side-by-side dispatch ───

export function renderSide(
  canvasL: HTMLCanvasElement,
  ctxL: CanvasRenderingContext2D,
  canvasR: HTMLCanvasElement,
  ctxR: CanvasRenderingContext2D,
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  fade: number,
  thresh: number,
  rawMode: boolean,
): { natW: number; natH: number } {
  const { natW, natH } = getNaturalDimensions(imgOld, imgNew)

  if (rawMode) {
    renderSideRaw(canvasL, ctxL, imgOld, natW, natH)
    renderSideRaw(canvasR, ctxR, imgNew, natW, natH)
  } else {
    const pw = Math.round(natW * DPR)
    const ph = Math.round(natH * DPR)
    const dOld = rasterize(imgOld, pw, ph)
    const dNew = rasterize(imgNew, pw, ph)
    renderSideAnnotated(canvasL, ctxL, dOld.data, dNew.data, pw, ph, true, fade, thresh)
    renderSideAnnotated(canvasR, ctxR, dOld.data, dNew.data, pw, ph, false, fade, thresh)
  }
  return { natW, natH }
}

// ─── Viewport-level hi-res renderers ───

export function renderDiffViewport(
  hiResCanvas: HTMLCanvasElement,
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  fade: number,
  thresh: number,
  srcX: number, srcY: number, srcW: number, srcH: number,
  vpW: number, vpH: number,
) {
  const pw = Math.round(vpW * DPR)
  const ph = Math.round(vpH * DPR)
  setCanvasBacking(hiResCanvas, pw, ph)
  hiResCanvas.style.width = vpW + 'px'
  hiResCanvas.style.height = vpH + 'px'

  const dOld = rasterizeRegion(imgOld, srcX, srcY, srcW, srcH, pw, ph)
  const dNew = rasterizeRegion(imgNew, srcX, srcY, srcW, srcH, pw, ph)
  const mask = buildDiffMask(dOld.data, dNew.data, pw * ph, thresh)
  const out = applyDiffColors(dOld.data, dNew.data, mask, fade, pw, ph)

  const ctx = hiResCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(out, 0, 0)
}

export function renderSideAnnotatedViewport(
  hiResCanvasL: HTMLCanvasElement,
  hiResCanvasR: HTMLCanvasElement,
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  fade: number,
  thresh: number,
  srcX: number, srcY: number, srcW: number, srcH: number,
  vpW: number, vpH: number,
) {
  const pw = Math.round(vpW * DPR)
  const ph = Math.round(vpH * DPR)

  const dOld = rasterizeRegion(imgOld, srcX, srcY, srcW, srcH, pw, ph)
  const dNew = rasterizeRegion(imgNew, srcX, srcY, srcW, srcH, pw, ph)

  // Left (old)
  setCanvasBacking(hiResCanvasL, pw, ph)
  hiResCanvasL.style.width = vpW + 'px'
  hiResCanvasL.style.height = vpH + 'px'
  const outL = applySideAnnotatedColors(dOld.data, dNew.data, pw, ph, true, fade, thresh)
  const ctxL = hiResCanvasL.getContext('2d', { willReadFrequently: true })!
  ctxL.setTransform(1, 0, 0, 1, 0, 0)
  ctxL.putImageData(outL, 0, 0)

  // Right (new)
  setCanvasBacking(hiResCanvasR, pw, ph)
  hiResCanvasR.style.width = vpW + 'px'
  hiResCanvasR.style.height = vpH + 'px'
  const outR = applySideAnnotatedColors(dOld.data, dNew.data, pw, ph, false, fade, thresh)
  const ctxR = hiResCanvasR.getContext('2d', { willReadFrequently: true })!
  ctxR.setTransform(1, 0, 0, 1, 0, 0)
  ctxR.putImageData(outR, 0, 0)
}

// ─── Change detection (for tab dots) ───

export function detectChanges(
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
): boolean {
  const size = 400
  const w = size
  const aspect = getSourceHeight(imgOld) / (getSourceWidth(imgOld) || 1)
  const h = Math.round(size * aspect) || size

  const oc1 = new OffscreenCanvas(w, h)
  const oc2 = new OffscreenCanvas(w, h)
  const x1 = oc1.getContext('2d')!
  const x2 = oc2.getContext('2d')!
  x1.fillStyle = '#fff'
  x1.fillRect(0, 0, w, h)
  x1.drawImage(imgOld, 0, 0, w, h)
  x2.fillStyle = '#fff'
  x2.fillRect(0, 0, w, h)
  x2.drawImage(imgNew, 0, 0, w, h)

  const d1 = x1.getImageData(0, 0, w, h).data
  const d2 = x2.getImageData(0, 0, w, h).data
  for (let i = 0; i < d1.length; i += 4) {
    const diff = Math.max(
      Math.abs(d1[i] - d2[i]),
      Math.abs(d1[i + 1] - d2[i + 1]),
      Math.abs(d1[i + 2] - d2[i + 2]),
    )
    if (diff > 20) return true
  }
  return false
}
