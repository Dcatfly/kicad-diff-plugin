// ─── Pure rendering functions: pixel-level diff, overlay, side-by-side ───

export const DPR = window.devicePixelRatio || 1

// ─── Types ───

/** Single image or array of images to composite (source-over). */
export type ImageSource = CanvasImageSource | CanvasImageSource[]

export interface ViewportRegion {
  srcX: number; srcY: number; srcW: number; srcH: number
  cssW: number; cssH: number
}

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

function getNaturalDimensions(imgOld: ImageSource, imgNew: ImageSource) {
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

// ─── Internal compositing helpers ───
// These draw one or more images onto a context, preserving source-over compositing.
// When compositing multiple layers (array), each layer is drawn with reduced
// opacity so that lower layers remain visible — matching KiCad's internal
// multi-layer rendering behaviour.

const LAYER_ALPHA = 0.4

function drawAllFull(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  imgs: ImageSource,
  dw: number,
  dh: number,
) {
  const arr = Array.isArray(imgs) ? imgs : [imgs]
  if (arr.length <= 1) {
    for (const img of arr) ctx.drawImage(img, 0, 0, dw, dh)
    return
  }
  const saved = ctx.globalAlpha
  for (const img of arr) {
    ctx.globalAlpha = saved * LAYER_ALPHA
    ctx.drawImage(img, 0, 0, dw, dh)
  }
  ctx.globalAlpha = saved
}

function drawAllRegion(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  imgs: ImageSource,
  sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number,
) {
  const arr = Array.isArray(imgs) ? imgs : [imgs]
  if (arr.length <= 1) {
    for (const img of arr) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    return
  }
  const saved = ctx.globalAlpha
  for (const img of arr) {
    ctx.globalAlpha = saved * LAYER_ALPHA
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
  }
  ctx.globalAlpha = saved
}

function rasterize(img: ImageSource, pw: number, ph: number): ImageData {
  const oc = new OffscreenCanvas(pw, ph)
  const octx = oc.getContext('2d')!
  drawAllFull(octx, img, pw, ph)
  return octx.getImageData(0, 0, pw, ph)
}

function rasterizeRegion(
  img: ImageSource,
  sx: number, sy: number, sw: number, sh: number,
  pw: number, ph: number,
): ImageData {
  const oc = new OffscreenCanvas(pw, ph)
  const octx = oc.getContext('2d')!
  drawAllRegion(octx, img, sx, sy, sw, sh, 0, 0, pw, ph)
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
    const aO = oldP[i + 3]
    const aN = newP[i + 3]
    if (aO === 0 && aN === 0) continue
    const diff = Math.max(
      Math.abs(oldP[i] - newP[i]),
      Math.abs(oldP[i + 1] - newP[i + 1]),
      Math.abs(oldP[i + 2] - newP[i + 2]),
      Math.abs(aO - aN),
    )
    if (diff > thresh) mask[p] = 1
  }
  return mask
}

function parseBgColor(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#ffffff'
  const n = parseInt(normalized.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// ─── Shared pixel loops ───

function applyDiffColors(
  oldP: Uint8ClampedArray,
  newP: Uint8ClampedArray,
  mask: Uint8Array,
  fade: number,
  pw: number,
  ph: number,
  bgColor: string,
): ImageData {
  const out = new ImageData(pw, ph)
  const od = out.data
  const fadeAlpha = 1 - fade / 100
  const [bgR, bgG, bgB] = parseBgColor(bgColor)
  const fadeBgR = 15, fadeBgG = 15, fadeBgB = 35

  for (let p = 0; p < pw * ph; p++) {
    const i = p << 2
    const aO = oldP[i + 3]
    const aN = newP[i + 3]
    const ro = aO === 0 ? bgR : oldP[i]
    const go = aO === 0 ? bgG : oldP[i + 1]
    const bo = aO === 0 ? bgB : oldP[i + 2]
    const rn = aN === 0 ? bgR : newP[i]
    const gn = aN === 0 ? bgG : newP[i + 1]
    const bn = aN === 0 ? bgB : newP[i + 2]
    if (mask[p]) {
      const oldIsBlank = aO === 0
      const newIsBlank = aN === 0
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
      od[i] = Math.round(rn * fadeAlpha + fadeBgR * (1 - fadeAlpha))
      od[i + 1] = Math.round(gn * fadeAlpha + fadeBgG * (1 - fadeAlpha))
      od[i + 2] = Math.round(bn * fadeAlpha + fadeBgB * (1 - fadeAlpha))
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
  bgColor: string,
): ImageData {
  const fadeAlpha = 1 - fade / 100
  const [bgR, bgG, bgB] = parseBgColor(bgColor)
  const fadeBgR = 15, fadeBgG = 15, fadeBgB = 35

  const outImg = new ImageData(pw, ph)
  const od = outImg.data
  for (let p = 0; p < pw * ph; p++) {
    const i = p << 2
    const aO = oldP[i + 3]
    const aN = newP[i + 3]
    const ro = aO === 0 ? bgR : oldP[i]
    const go = aO === 0 ? bgG : oldP[i + 1]
    const bo = aO === 0 ? bgB : oldP[i + 2]
    const rn = aN === 0 ? bgR : newP[i]
    const gn = aN === 0 ? bgG : newP[i + 1]
    const bn = aN === 0 ? bgB : newP[i + 2]
    const r = isOld ? ro : rn
    const g = isOld ? go : gn
    const b = isOld ? bo : bn
    const diff = Math.max(
      Math.abs(ro - rn),
      Math.abs(go - gn),
      Math.abs(bo - bn),
      Math.abs(aO - aN),
    )

    // Highlight only when this side has content at this pixel
    const mySideHasContent = isOld ? aO > 0 : aN > 0
    if (diff > thresh && mySideHasContent) {
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
      od[i] = Math.round(r * fadeAlpha + fadeBgR * (1 - fadeAlpha))
      od[i + 1] = Math.round(g * fadeAlpha + fadeBgG * (1 - fadeAlpha))
      od[i + 2] = Math.round(b * fadeAlpha + fadeBgB * (1 - fadeAlpha))
      od[i + 3] = 255
    }
  }
  return outImg
}

// ─── Diff mode renderer (native resolution) ───

export function renderDiff(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  imgOld: ImageSource,
  imgNew: ImageSource,
  fade: number,
  thresh: number,
  bgColor: string,
): { natW: number; natH: number } {
  const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
  const pw = Math.round(natW * DPR)
  const ph = Math.round(natH * DPR)
  setCanvasBacking(canvas, pw, ph)

  const dOld = rasterize(imgOld, pw, ph)
  const dNew = rasterize(imgNew, pw, ph)
  const mask = buildDiffMask(dOld.data, dNew.data, pw * ph, thresh)
  const out = applyDiffColors(dOld.data, dNew.data, mask, fade, pw, ph, bgColor)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(out, 0, 0)
  return { natW, natH }
}

// ─── Overlay mode renderer (native resolution) ───

export function renderOverlay(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  imgOld: ImageSource,
  imgNew: ImageSource,
  overlay: number,
  bgColor: string,
  viewport?: ViewportRegion,
): { natW: number; natH: number } {
  const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
  const vp = viewport
  const drawW = vp ? vp.cssW : natW
  const drawH = vp ? vp.cssH : natH
  const pw = Math.round(drawW * DPR)
  const ph = Math.round(drawH * DPR)
  setCanvasBacking(canvas, pw, ph)
  if (vp) {
    canvas.style.width = drawW + 'px'
    canvas.style.height = drawH + 'px'
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, drawW, drawH)
  ctx.globalAlpha = 1
  if (vp) {
    drawAllRegion(ctx, imgOld, vp.srcX, vp.srcY, vp.srcW, vp.srcH, 0, 0, drawW, drawH)
    ctx.globalAlpha = overlay / 100
    drawAllRegion(ctx, imgNew, vp.srcX, vp.srcY, vp.srcW, vp.srcH, 0, 0, drawW, drawH)
  } else {
    drawAllFull(ctx, imgOld, natW, natH)
    ctx.globalAlpha = overlay / 100
    drawAllFull(ctx, imgNew, natW, natH)
  }
  ctx.globalAlpha = 1
  return { natW, natH }
}

// ─── Side-by-side mode renderers (native resolution) ───

export function renderSideRaw(
  cvs: HTMLCanvasElement,
  cctx: CanvasRenderingContext2D,
  img: ImageSource,
  natW: number,
  natH: number,
  bgColor: string,
  viewport?: ViewportRegion,
) {
  const vp = viewport
  const drawW = vp ? vp.cssW : natW
  const drawH = vp ? vp.cssH : natH
  const pw = Math.round(drawW * DPR)
  const ph = Math.round(drawH * DPR)
  setCanvasBacking(cvs, pw, ph)
  if (vp) {
    cvs.style.width = drawW + 'px'
    cvs.style.height = drawH + 'px'
  }
  cctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  cctx.imageSmoothingEnabled = true
  cctx.imageSmoothingQuality = 'high'
  cctx.fillStyle = bgColor
  cctx.fillRect(0, 0, drawW, drawH)
  if (vp) {
    drawAllRegion(cctx, img, vp.srcX, vp.srcY, vp.srcW, vp.srcH, 0, 0, drawW, drawH)
  } else {
    drawAllFull(cctx, img, natW, natH)
  }
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
  bgColor: string,
) {
  setCanvasBacking(cvs, pw, ph)
  const outImg = applySideAnnotatedColors(oldPixels, newPixels, pw, ph, isOld, fade, thresh, bgColor)
  cctx.setTransform(1, 0, 0, 1, 0, 0)
  cctx.putImageData(outImg, 0, 0)
}

// ─── Side-by-side dispatch ───

export function renderSide(
  canvasL: HTMLCanvasElement,
  ctxL: CanvasRenderingContext2D,
  canvasR: HTMLCanvasElement,
  ctxR: CanvasRenderingContext2D,
  imgOld: ImageSource,
  imgNew: ImageSource,
  fade: number,
  thresh: number,
  rawMode: boolean,
  bgColor: string,
): { natW: number; natH: number } {
  const { natW, natH } = getNaturalDimensions(imgOld, imgNew)

  if (rawMode) {
    renderSideRaw(canvasL, ctxL, imgOld, natW, natH, bgColor)
    renderSideRaw(canvasR, ctxR, imgNew, natW, natH, bgColor)
  } else {
    const pw = Math.round(natW * DPR)
    const ph = Math.round(natH * DPR)
    const dOld = rasterize(imgOld, pw, ph)
    const dNew = rasterize(imgNew, pw, ph)
    renderSideAnnotated(canvasL, ctxL, dOld.data, dNew.data, pw, ph, true, fade, thresh, bgColor)
    renderSideAnnotated(canvasR, ctxR, dOld.data, dNew.data, pw, ph, false, fade, thresh, bgColor)
  }
  return { natW, natH }
}

// ─── Viewport-level hi-res renderers ───

export function renderDiffViewport(
  hiResCanvas: HTMLCanvasElement,
  imgOld: ImageSource,
  imgNew: ImageSource,
  fade: number,
  thresh: number,
  srcX: number, srcY: number, srcW: number, srcH: number,
  vpW: number, vpH: number,
  bgColor: string,
) {
  const pw = Math.round(vpW * DPR)
  const ph = Math.round(vpH * DPR)
  setCanvasBacking(hiResCanvas, pw, ph)
  hiResCanvas.style.width = vpW + 'px'
  hiResCanvas.style.height = vpH + 'px'

  const dOld = rasterizeRegion(imgOld, srcX, srcY, srcW, srcH, pw, ph)
  const dNew = rasterizeRegion(imgNew, srcX, srcY, srcW, srcH, pw, ph)
  const mask = buildDiffMask(dOld.data, dNew.data, pw * ph, thresh)
  const out = applyDiffColors(dOld.data, dNew.data, mask, fade, pw, ph, bgColor)

  const ctx = hiResCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(out, 0, 0)
}

export function renderSideAnnotatedViewport(
  hiResCanvasL: HTMLCanvasElement,
  hiResCanvasR: HTMLCanvasElement,
  imgOld: ImageSource,
  imgNew: ImageSource,
  fade: number,
  thresh: number,
  srcX: number, srcY: number, srcW: number, srcH: number,
  vpW: number, vpH: number,
  bgColor: string,
) {
  const pw = Math.round(vpW * DPR)
  const ph = Math.round(vpH * DPR)

  const dOld = rasterizeRegion(imgOld, srcX, srcY, srcW, srcH, pw, ph)
  const dNew = rasterizeRegion(imgNew, srcX, srcY, srcW, srcH, pw, ph)

  // Left (old)
  setCanvasBacking(hiResCanvasL, pw, ph)
  hiResCanvasL.style.width = vpW + 'px'
  hiResCanvasL.style.height = vpH + 'px'
  const outL = applySideAnnotatedColors(dOld.data, dNew.data, pw, ph, true, fade, thresh, bgColor)
  const ctxL = hiResCanvasL.getContext('2d', { willReadFrequently: true })!
  ctxL.setTransform(1, 0, 0, 1, 0, 0)
  ctxL.putImageData(outL, 0, 0)

  // Right (new)
  setCanvasBacking(hiResCanvasR, pw, ph)
  hiResCanvasR.style.width = vpW + 'px'
  hiResCanvasR.style.height = vpH + 'px'
  const outR = applySideAnnotatedColors(dOld.data, dNew.data, pw, ph, false, fade, thresh, bgColor)
  const ctxR = hiResCanvasR.getContext('2d', { willReadFrequently: true })!
  ctxR.setTransform(1, 0, 0, 1, 0, 0)
  ctxR.putImageData(outR, 0, 0)
}

// ─── Change detection (for tab dots) ───

export function detectChanges(
  imgOld: CanvasImageSource,
  imgNew: CanvasImageSource,
  thresh: number,
): boolean {
  const size = 400
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
  for (let i = 0; i < d1.length; i += 4) {
    const diff = Math.max(
      Math.abs(d1[i] - d2[i]),
      Math.abs(d1[i + 1] - d2[i + 1]),
      Math.abs(d1[i + 2] - d2[i + 2]),
      Math.abs(d1[i + 3] - d2[i + 3]),
    )
    if (diff > thresh) return true
  }
  return false
}
