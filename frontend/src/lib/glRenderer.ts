// ─── WebGL diff renderer: GPU-accelerated pixel comparison and colouring ───
//
// Replaces CPU-side pixel loops (buildDiffMask + applyDiffColors etc.) with
// fragment shaders.  Slider drags only update uniforms + one draw call (<0.5ms),
// image switches only re-upload textures (1-10ms).
//
// Architecture:
//   GLRenderer (one per <canvas>)
//   ├── WebGL context + 4 shader programs (diff / overlay / sideAnnotated / raw)
//   ├── 2 textures (texOld, texNew) + identity cache
//   ├── full-screen quad vertex buffer
//   ├── UV region uniforms (full image or viewport sub-region)
//   └── context loss / restore handling

import type { ImageSource } from './renderer'
import { FADE_BG, LAYER_ALPHA } from './constants'

// ─── Shader sources ───

/**
 * Shared vertex shader for all programs.
 *
 * Draws a full-screen quad in clip space [-1,1] and computes texture UVs.
 * UV region (u_uvOffset / u_uvScale) allows rendering a sub-region of the
 * texture for hi-res viewport overlays.
 *
 * Y-axis is flipped in the UV calculation (1.0 - uv01.y) so that the GL
 * texture origin (bottom-left) maps to the image origin (top-left) without
 * needing UNPACK_FLIP_Y_WEBGL.
 */
const VERT_SRC = `
attribute vec2 a_position;
uniform vec2 u_uvOffset;
uniform vec2 u_uvScale;
varying vec2 v_uv;

void main() {
  vec2 uv01 = a_position * 0.5 + 0.5;
  v_uv = u_uvOffset + vec2(uv01.x, 1.0 - uv01.y) * u_uvScale;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * Diff fragment shader — reproduces applyDiffColors logic.
 *
 * Algorithm:
 *   1. Sample old and new texels, replace transparent pixels with bgColor
 *   2. Compute per-channel max absolute difference (mask test)
 *   3. If diff > threshold → apply change colouring:
 *      - old transparent, new opaque  → green tint  (added content)
 *      - old opaque, new transparent  → red tint    (removed content)
 *      - both opaque                  → yellow tint (modified content)
 *   4. If unchanged → fade towards fadeBg colour
 */
const FRAG_DIFF = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texOld;
uniform sampler2D u_texNew;
uniform float u_thresh;
uniform float u_fadeAlpha;
uniform vec3 u_bgColor;
uniform vec3 u_fadeBg;

void main() {
  vec4 cOld = texture2D(u_texOld, v_uv);
  vec4 cNew = texture2D(u_texNew, v_uv);

  // Premultiply: replace transparent pixels with background
  vec3 pOld = cOld.a < 0.004 ? u_bgColor : cOld.rgb;
  vec3 pNew = cNew.a < 0.004 ? u_bgColor : cNew.rgb;

  // Diff mask: max channel difference (operating in 0-1 space)
  float diff = max(
    max(abs(pOld.r - pNew.r), abs(pOld.g - pNew.g)),
    max(abs(pOld.b - pNew.b), abs(cOld.a - cNew.a))
  );

  vec3 result;
  if (diff > u_thresh) {
    bool oldBlank = cOld.a < 0.004;
    bool newBlank = cNew.a < 0.004;
    if (oldBlank && !newBlank) {
      // Added: green tint
      result = vec3(pNew.r * 0.3, min(1.0, pNew.g * 0.5 + 0.4706), pNew.b * 0.3);
    } else if (!oldBlank && newBlank) {
      // Removed: red tint
      result = vec3(min(1.0, pOld.r * 0.5 + 0.4706), pOld.g * 0.3, pOld.b * 0.3);
    } else {
      // Modified: yellow tint
      result = vec3(
        min(1.0, pNew.r * 0.4 + 0.5882),
        min(1.0, pNew.g * 0.3 + 0.3922),
        pNew.b * 0.2
      );
    }
  } else {
    // Unchanged: fade towards fadeBg
    result = mix(u_fadeBg, pNew, u_fadeAlpha);
  }

  gl_FragColor = vec4(result, 1.0);
}
`

/**
 * Overlay fragment shader — reproduces applyOverlayColors logic.
 *
 * Changed pixels: linear blend old*(1-t) + new*t.
 * Unchanged pixels: show new image as-is.
 */
const FRAG_OVERLAY = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texOld;
uniform sampler2D u_texNew;
uniform float u_thresh;
uniform float u_overlayT;
uniform vec3 u_bgColor;

void main() {
  vec4 cOld = texture2D(u_texOld, v_uv);
  vec4 cNew = texture2D(u_texNew, v_uv);

  vec3 pOld = cOld.a < 0.004 ? u_bgColor : cOld.rgb;
  vec3 pNew = cNew.a < 0.004 ? u_bgColor : cNew.rgb;

  float diff = max(
    max(abs(pOld.r - pNew.r), abs(pOld.g - pNew.g)),
    max(abs(pOld.b - pNew.b), abs(cOld.a - cNew.a))
  );

  vec3 result;
  if (diff > u_thresh) {
    result = mix(pOld, pNew, u_overlayT);
  } else {
    result = pNew;
  }

  gl_FragColor = vec4(result, 1.0);
}
`

/**
 * Side-annotated fragment shader — reproduces applySideAnnotatedColors.
 *
 * Shows one side's image with diff highlights:
 *   - u_isOld = 1.0 → left panel (red highlight for old-side changes)
 *   - u_isOld = 0.0 → right panel (green highlight for new-side changes)
 *
 * Only highlights pixels where "this side" has content (alpha > 0).
 * Unchanged pixels fade towards fadeBg.
 */
const FRAG_SIDE_ANNOTATED = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texOld;
uniform sampler2D u_texNew;
uniform float u_thresh;
uniform float u_fadeAlpha;
uniform vec3 u_bgColor;
uniform vec3 u_fadeBg;
uniform float u_isOld;

void main() {
  vec4 cOld = texture2D(u_texOld, v_uv);
  vec4 cNew = texture2D(u_texNew, v_uv);

  vec3 pOld = cOld.a < 0.004 ? u_bgColor : cOld.rgb;
  vec3 pNew = cNew.a < 0.004 ? u_bgColor : cNew.rgb;

  // Choose which side to show
  vec3 side = u_isOld > 0.5 ? pOld : pNew;
  float sideAlpha = u_isOld > 0.5 ? cOld.a : cNew.a;

  float diff = max(
    max(abs(pOld.r - pNew.r), abs(pOld.g - pNew.g)),
    max(abs(pOld.b - pNew.b), abs(cOld.a - cNew.a))
  );

  vec3 result;
  bool mySideHasContent = sideAlpha > 0.004;
  if (diff > u_thresh && mySideHasContent) {
    if (u_isOld > 0.5) {
      // Old side: red highlight
      result = vec3(min(1.0, side.r * 0.5 + 0.4706), side.g * 0.35, side.b * 0.35);
    } else {
      // New side: green highlight
      result = vec3(side.r * 0.35, min(1.0, side.g * 0.5 + 0.4706), side.b * 0.35);
    }
  } else {
    result = mix(u_fadeBg, side, u_fadeAlpha);
  }

  gl_FragColor = vec4(result, 1.0);
}
`

/**
 * Raw fragment shader — direct texture display.
 *
 * Replaces transparent pixels with background colour.
 * Used for side-by-side raw mode.
 */
const FRAG_RAW = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_bgColor;

void main() {
  vec4 c = texture2D(u_tex, v_uv);
  vec3 result = c.a < 0.004 ? u_bgColor : c.rgb;
  gl_FragColor = vec4(result, 1.0);
}
`

// ─── Types ───

interface ProgramInfo {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation>
  aPosition: number
}

type ProgramName = 'diff' | 'overlay' | 'sideAnnotated' | 'raw'

/** Per-slot texture state: GPU texture + identity cache for skip-upload optimisation. */
interface TextureSlot {
  tex: WebGLTexture | null
  input: ImageSource | null
  pw: number
  ph: number
}

function emptySlot(): TextureSlot {
  return { tex: null, input: null, pw: 0, ph: 0 }
}

// ─── Helpers ───

/**
 * Compile a single GLSL shader.
 * @throws Error with shader info log on compilation failure.
 */
function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile error: ${log}`)
  }
  return shader
}

/**
 * Link a vertex + fragment shader pair into a program and extract uniform locations.
 *
 * @param uniformNames - Names of uniforms to look up; locations are stored in the
 *   returned ProgramInfo.uniforms map.
 */
function buildProgram(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string,
  uniformNames: string[],
): ProgramInfo {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  const program = gl.createProgram()!
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_position')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`Program link error: ${log}`)
  }
  // Shaders can be detached after linking
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  const uniforms: Record<string, WebGLUniformLocation> = {}
  for (const name of uniformNames) {
    uniforms[name] = gl.getUniformLocation(program, name)!
  }
  return { program, uniforms, aPosition: 0 }
}

/**
 * Parse a hex colour string (#rrggbb) into a normalised [r, g, b] triple (0-1).
 * Single-value cache avoids redundant parseInt on every frame during slider drags.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
let _bgCache: { hex: string; rgb: [number, number, number] } | null = null

function parseBgColorGL(hex: string): [number, number, number] {
  if (_bgCache && _bgCache.hex === hex) return _bgCache.rgb
  const normalized = HEX_COLOR_RE.test(hex) ? hex : '#ffffff'
  const n = parseInt(normalized.slice(1), 16)
  const rgb: [number, number, number] = [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ]
  _bgCache = { hex, rgb }
  return rgb
}

/**
 * Pre-rasterize image source(s) to an OffscreenCanvas at the target
 * physical pixel dimensions (pw × ph).
 *
 * This step is critical for rendering sharpness: the source image is
 * drawn to the exact output resolution using Canvas 2D's high-quality
 * resampling (bicubic/Lanczos), matching the old CPU pipeline's
 * `rasterize(img, pw, ph)`. Without this, WebGL's bilinear texture
 * filtering on a lower-resolution source causes visible blurriness,
 * especially on high-DPR screens.
 *
 * For multi-layer sources (PCB), each layer is drawn with LAYER_ALPHA
 * opacity so that lower layers remain visible, matching KiCad's
 * internal multi-layer rendering.
 *
 * When source region (sx, sy, sw, sh) is provided, only that sub-region
 * is drawn to fill the entire output canvas — used by hi-res viewport
 * rendering for pixel-perfect sharpness at any zoom level.
 */
function rasterize(
  imgs: ImageSource, pw: number, ph: number,
  sx?: number, sy?: number, sw?: number, sh?: number,
): OffscreenCanvas {
  const arr = Array.isArray(imgs) ? imgs : [imgs]
  const oc = new OffscreenCanvas(pw, ph)
  const ctx = oc.getContext('2d')!
  const useAlpha = arr.length > 1
  for (const img of arr) {
    if (useAlpha) ctx.globalAlpha = LAYER_ALPHA
    if (sx != null) {
      ctx.drawImage(img, sx, sy!, sw!, sh!, 0, 0, pw, ph)
    } else {
      ctx.drawImage(img, 0, 0, pw, ph)
    }
  }
  return oc
}

// Normalised FADE_BG colour (constant, computed once)
const FADE_BG_NORM: [number, number, number] = [
  FADE_BG[0] / 255,
  FADE_BG[1] / 255,
  FADE_BG[2] / 255,
]

// ─── GLRenderer class ───

/**
 * GPU-accelerated renderer for a single canvas element.
 *
 * Manages a WebGL context, four shader programs, up to two textures,
 * and a full-screen quad. Rendering only requires setting uniforms and
 * issuing a single draw call, making slider interactions near-instant.
 *
 * Lifecycle:
 *   1. Construct with a canvas element (WebGL context is acquired lazily)
 *   2. Upload textures via uploadPair() or uploadSingle()
 *   3. Set canvas size via setSize()
 *   4. Optionally set a UV sub-region via setViewport()
 *   5. Call renderDiff / renderOverlay / renderSideAnnotated / renderRaw
 *   6. Call dispose() when the canvas is no longer needed
 */
export class GLRenderer {
  readonly canvasElement: HTMLCanvasElement
  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext | null = null
  private programs: Partial<Record<ProgramName, ProgramInfo>> = {}
  private quadBuf: WebGLBuffer | null = null

  // Texture slots with identity cache — keyed on (ImageSource, pw, ph).
  // The ImageSource reference check ensures multi-layer arrays (which
  // produce a new OffscreenCanvas each rasterization) still cache-hit
  // when the same array object is passed again. The pw/ph check ensures
  // resolution changes (e.g. DPR change) trigger re-rasterization.
  private slots: Record<'old' | 'new', TextureSlot> = {
    old: emptySlot(),
    new: emptySlot(),
  }

  // UV region state (default = full image)
  private uvOffset: [number, number] = [0, 0]
  private uvScale: [number, number] = [1, 1]

  // Saved sources for context restore
  private lastImgOld: ImageSource | null = null
  private lastImgNew: ImageSource | null = null
  private lastSingleImg: ImageSource | null = null
  private lastNatW = 0
  private lastNatH = 0

  private contextLost = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvasElement = canvas
    this.canvas = canvas

    // Event listeners registered once in constructor (not in initGL)
    // to avoid duplicate registration on context restore.
    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.initGL()
  }

  // ─── WebGL initialisation ───

  /**
   * Acquire WebGL context, compile all shader programs, and create the
   * full-screen quad vertex buffer.
   *
   * Called once in constructor and again after context restore.
   * Event listeners are NOT registered here — they are set up once in
   * the constructor to avoid duplicate bindings on restore.
   */
  private initGL(): void {
    const gl = this.canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL not supported')
    this.gl = gl
    this.contextLost = false

    // Full-screen quad: two triangles covering [-1,1] clip space
    this.quadBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW)

    // Build all four shader programs
    this.programs.diff = buildProgram(gl, VERT_SRC, FRAG_DIFF, [
      'u_texOld', 'u_texNew', 'u_thresh', 'u_fadeAlpha',
      'u_bgColor', 'u_fadeBg', 'u_uvOffset', 'u_uvScale',
    ])
    this.programs.overlay = buildProgram(gl, VERT_SRC, FRAG_OVERLAY, [
      'u_texOld', 'u_texNew', 'u_thresh', 'u_overlayT',
      'u_bgColor', 'u_uvOffset', 'u_uvScale',
    ])
    this.programs.sideAnnotated = buildProgram(gl, VERT_SRC, FRAG_SIDE_ANNOTATED, [
      'u_texOld', 'u_texNew', 'u_thresh', 'u_fadeAlpha',
      'u_bgColor', 'u_fadeBg', 'u_isOld', 'u_uvOffset', 'u_uvScale',
    ])
    this.programs.raw = buildProgram(gl, VERT_SRC, FRAG_RAW, [
      'u_tex', 'u_bgColor', 'u_uvOffset', 'u_uvScale',
    ])
  }

  /**
   * Handle WebGL context loss.
   * Prevents default (which would discard the context permanently),
   * marks the renderer as lost, and clears texture identity cache.
   */
  private onContextLost = (e: Event): void => {
    e.preventDefault()
    this.contextLost = true
    // Clear GL resource references (they're invalid now)
    this.gl = null
    this.programs = {}
    this.quadBuf = null
    this.clearSlots()
  }

  /**
   * Handle WebGL context restoration.
   *
   * Re-initialises shaders, re-uploads the last-known textures, and
   * restores the viewport. The next renderXxx() call will produce
   * correct output without the caller needing to do anything.
   */
  private onContextRestored = (): void => {
    this.initGL()
    // Re-upload last-known textures at last-known resolution
    if (this.lastImgOld && this.lastImgNew) {
      this.uploadPair(this.lastImgOld, this.lastImgNew, this.lastNatW, this.lastNatH)
    } else if (this.lastSingleImg) {
      this.uploadSingle(this.lastSingleImg, this.lastNatW, this.lastNatH)
    }
  }

  // ─── Texture management ───

  /**
   * Create a WebGL texture with standard settings for image display.
   *
   * Uses CLAMP_TO_EDGE wrapping and LINEAR filtering for clean scaling.
   * Returns the created texture object.
   */
  private createTexture(): WebGLTexture {
    const gl = this.gl!
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return tex
  }

  /**
   * Upload pre-rasterized image data to a WebGL texture.
   *
   * Identity cache is keyed on (ImageSource reference, pw, ph). This
   * ensures that:
   *   - Multi-layer arrays (new OffscreenCanvas each call) still
   *     cache-hit when the same ImageSource is passed during slider drags
   *   - Resolution changes (DPR change) trigger re-upload
   *
   * @param slot       - 'old' or 'new', determining which texture unit is targeted
   * @param input      - The original ImageSource (used for identity caching)
   * @param pw         - Physical pixel width of the rasterized image
   * @param ph         - Physical pixel height of the rasterized image
   * @param rasterized - The pre-rasterized OffscreenCanvas to upload to GPU
   */
  private uploadTexture(
    slot: 'old' | 'new',
    input: ImageSource,
    pw: number,
    ph: number,
    data: OffscreenCanvas,
  ): void {
    const gl = this.gl!
    const s = this.slots[slot]

    if (s.input === input && s.pw === pw && s.ph === ph) return

    if (!s.tex) s.tex = this.createTexture()

    gl.bindTexture(gl.TEXTURE_2D, s.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data)

    s.input = input
    s.pw = pw
    s.ph = ph
  }

  /**
   * Delete GPU textures (if context is alive) and reset all slot state.
   * Safe to call after context loss — skips gl.deleteTexture when
   * the context is lost since GPU resources are already invalid.
   */
  private clearSlots(): void {
    if (this.gl && !this.contextLost) {
      for (const s of Object.values(this.slots)) {
        if (s.tex) this.gl.deleteTexture(s.tex)
      }
    }
    this.slots = { old: emptySlot(), new: emptySlot() }
  }

  /**
   * Upload a pair of images (old + new) as textures at the specified
   * physical pixel resolution.
   *
   * Images are pre-rasterized to pw × ph using Canvas 2D's high-quality
   * resampling (bicubic), then uploaded to the GPU. This ensures the
   * texture matches the output canvas resolution for pixel-perfect
   * rendering, especially important on high-DPR displays.
   *
   * For multi-layer sources (ImageSource[]), layers are composited with
   * LAYER_ALPHA during rasterization. Identity caching (keyed on
   * ImageSource + pw + ph) prevents redundant rasterization + upload
   * during slider drags.
   *
   * @param imgOld - Old image source
   * @param imgNew - New image source
   * @param pw     - Target physical pixel width (typically natW * DPR)
   * @param ph     - Target physical pixel height (typically natH * DPR)
   */
  uploadPair(imgOld: ImageSource, imgNew: ImageSource, pw: number, ph: number): void {
    if (this.contextLost || !this.gl) return

    this.lastImgOld = imgOld
    this.lastImgNew = imgNew
    this.lastSingleImg = null
    this.lastNatW = pw
    this.lastNatH = ph

    // Check cache BEFORE rasterizing to avoid wasted CPU work on slider drags
    const so = this.slots.old, sn = this.slots.new
    if (!(so.input === imgOld && so.pw === pw && so.ph === ph)) {
      this.uploadTexture('old', imgOld, pw, ph, rasterize(imgOld, pw, ph))
    }
    if (!(sn.input === imgNew && sn.pw === pw && sn.ph === ph)) {
      this.uploadTexture('new', imgNew, pw, ph, rasterize(imgNew, pw, ph))
    }
  }

  /**
   * Upload a single image as the "new" texture (for raw mode rendering)
   * at the specified physical pixel resolution.
   *
   * @param img - Image source
   * @param pw  - Target physical pixel width
   * @param ph  - Target physical pixel height
   */
  uploadSingle(img: ImageSource, pw: number, ph: number): void {
    if (this.contextLost || !this.gl) return

    this.lastSingleImg = img
    this.lastImgOld = null
    this.lastImgNew = null
    this.lastNatW = pw
    this.lastNatH = ph

    // Check cache BEFORE rasterizing
    const s = this.slots.new
    if (s.input === img && s.pw === pw && s.ph === ph) return
    this.uploadTexture('new', img, pw, ph, rasterize(img, pw, ph))
  }

  /**
   * Upload a pair of images, rasterizing only a sub-region to the
   * target physical pixel resolution.
   *
   * Used by hi-res viewport overlays: the visible portion of the source
   * images is drawn at the viewport's full DPR resolution using Canvas
   * 2D's high-quality resampling. The resulting texture covers the
   * entire output canvas (no UV sub-region needed), ensuring pixel-
   * perfect sharpness at any zoom level.
   *
   * Unlike uploadPair, this method always re-rasterizes (no identity
   * cache) because the source region changes on every scroll/zoom.
   *
   * @param imgOld - Old image source
   * @param imgNew - New image source
   * @param sx     - Source region left edge (image pixels)
   * @param sy     - Source region top edge (image pixels)
   * @param sw     - Source region width (image pixels)
   * @param sh     - Source region height (image pixels)
   * @param pw     - Target physical pixel width
   * @param ph     - Target physical pixel height
   */
  uploadPairRegion(
    imgOld: ImageSource, imgNew: ImageSource,
    sx: number, sy: number, sw: number, sh: number,
    pw: number, ph: number,
  ): void {
    if (this.contextLost || !this.gl) return

    // Force upload (no cache — region changes each scroll)
    this.slots.old.input = null
    this.slots.new.input = null
    this.uploadTexture('old', imgOld, pw, ph, rasterize(imgOld, pw, ph, sx, sy, sw, sh))
    this.uploadTexture('new', imgNew, pw, ph, rasterize(imgNew, pw, ph, sx, sy, sw, sh))
  }

  /**
   * Upload a single image, rasterizing only a sub-region.
   * See uploadPairRegion for details.
   */
  uploadSingleRegion(
    img: ImageSource,
    sx: number, sy: number, sw: number, sh: number,
    pw: number, ph: number,
  ): void {
    if (this.contextLost || !this.gl) return

    this.slots.new.input = null
    this.uploadTexture('new', img, pw, ph, rasterize(img, pw, ph, sx, sy, sw, sh))
  }

  // ─── Canvas sizing ───

  /**
   * Set the canvas backing buffer size (physical pixels) and update
   * the WebGL viewport to match.
   *
   * Should be called before rendering whenever the canvas dimensions
   * may have changed (e.g. on image load or window resize).
   */
  setSize(pw: number, ph: number): void {
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    if (this.gl && !this.contextLost) {
      this.gl.viewport(0, 0, pw, ph)
    }
  }

  // ─── UV region control ───

  /**
   * Set a UV sub-region for viewport rendering.
   *
   * Converts image-space coordinates (cx0, cy0, cw, ch) into normalised
   * UV offset + scale values that the vertex shader uses to sample only
   * the visible portion of the texture.
   *
   * @param cx0  - Left edge in image pixels
   * @param cy0  - Top edge in image pixels
   * @param cw   - Width in image pixels
   * @param ch   - Height in image pixels
   * @param natW - Full image width in pixels
   * @param natH - Full image height in pixels
   */
  setViewport(cx0: number, cy0: number, cw: number, ch: number, natW: number, natH: number): void {
    this.uvOffset = [cx0 / natW, cy0 / natH]
    this.uvScale = [cw / natW, ch / natH]
  }

  /**
   * Reset UV region to cover the full texture (default state).
   */
  resetViewport(): void {
    this.uvOffset = [0, 0]
    this.uvScale = [1, 1]
  }

  // ─── Internal draw helpers ───

  /**
   * Activate a shader program and configure shared state:
   *   1. Use the specified program
   *   2. Set UV offset/scale uniforms
   *   3. Bind the full-screen quad vertex buffer
   *   4. Enable the position attribute
   *
   * @returns The ProgramInfo for further uniform configuration, or null
   *   if the context is lost or the program doesn't exist.
   */
  private useProgram(name: ProgramName): ProgramInfo | null {
    if (this.contextLost || !this.gl) return null
    const info = this.programs[name]
    if (!info) return null
    const gl = this.gl

    gl.useProgram(info.program)

    // UV region
    gl.uniform2f(info.uniforms.u_uvOffset, this.uvOffset[0], this.uvOffset[1])
    gl.uniform2f(info.uniforms.u_uvScale, this.uvScale[0], this.uvScale[1])

    // Bind quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
    gl.enableVertexAttribArray(info.aPosition)
    gl.vertexAttribPointer(info.aPosition, 2, gl.FLOAT, false, 0, 0)

    return info
  }

  /**
   * Bind old + new textures to texture units 0 and 1, then set the
   * corresponding sampler uniforms.
   */
  private bindPairTextures(info: ProgramInfo): void {
    const gl = this.gl!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.slots.old.tex)
    gl.uniform1i(info.uniforms.u_texOld, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.slots.new.tex)
    gl.uniform1i(info.uniforms.u_texNew, 1)
  }

  /**
   * Issue the draw call for the full-screen quad (6 vertices, 2 triangles).
   */
  private draw(): void {
    this.gl!.drawArrays(this.gl!.TRIANGLES, 0, 6)
  }

  // ─── Public render methods ───

  /**
   * Render in diff mode.
   *
   * @param thresh  - Pixel difference threshold (0-255)
   * @param fade    - Fade percentage for unchanged pixels (0-100)
   * @param bgColor - Background colour hex string (#rrggbb)
   */
  renderDiff(thresh: number, fade: number, bgColor: string): void {
    const info = this.useProgram('diff')
    if (!info) return
    const gl = this.gl!

    this.bindPairTextures(info)

    const [bgR, bgG, bgB] = parseBgColorGL(bgColor)
    gl.uniform1f(info.uniforms.u_thresh, thresh / 255)
    gl.uniform1f(info.uniforms.u_fadeAlpha, 1 - fade / 100)
    gl.uniform3f(info.uniforms.u_bgColor, bgR, bgG, bgB)
    gl.uniform3f(info.uniforms.u_fadeBg, FADE_BG_NORM[0], FADE_BG_NORM[1], FADE_BG_NORM[2])

    this.draw()
  }

  /**
   * Render in overlay mode.
   *
   * @param thresh  - Pixel difference threshold (0-255)
   * @param overlay - Overlay blend percentage (0-100, 0=old, 100=new)
   * @param bgColor - Background colour hex string (#rrggbb)
   */
  renderOverlay(thresh: number, overlay: number, bgColor: string): void {
    const info = this.useProgram('overlay')
    if (!info) return
    const gl = this.gl!

    this.bindPairTextures(info)

    const [bgR, bgG, bgB] = parseBgColorGL(bgColor)
    gl.uniform1f(info.uniforms.u_thresh, thresh / 255)
    gl.uniform1f(info.uniforms.u_overlayT, overlay / 100)
    gl.uniform3f(info.uniforms.u_bgColor, bgR, bgG, bgB)

    this.draw()
  }

  /**
   * Render in side-annotated mode (one panel of side-by-side view).
   *
   * @param thresh  - Pixel difference threshold (0-255)
   * @param fade    - Fade percentage for unchanged pixels (0-100)
   * @param bgColor - Background colour hex string (#rrggbb)
   * @param isOld   - True for old/left panel, false for new/right panel
   */
  renderSideAnnotated(thresh: number, fade: number, bgColor: string, isOld: boolean): void {
    const info = this.useProgram('sideAnnotated')
    if (!info) return
    const gl = this.gl!

    this.bindPairTextures(info)

    const [bgR, bgG, bgB] = parseBgColorGL(bgColor)
    gl.uniform1f(info.uniforms.u_thresh, thresh / 255)
    gl.uniform1f(info.uniforms.u_fadeAlpha, 1 - fade / 100)
    gl.uniform3f(info.uniforms.u_bgColor, bgR, bgG, bgB)
    gl.uniform3f(info.uniforms.u_fadeBg, FADE_BG_NORM[0], FADE_BG_NORM[1], FADE_BG_NORM[2])
    gl.uniform1f(info.uniforms.u_isOld, isOld ? 1.0 : 0.0)

    this.draw()
  }

  /**
   * Render in raw mode (direct texture display with background fill).
   *
   * Uses the "new" texture slot. Call uploadSingle() before this method.
   *
   * @param bgColor - Background colour hex string (#rrggbb)
   */
  renderRaw(bgColor: string): void {
    const info = this.useProgram('raw')
    if (!info) return
    const gl = this.gl!

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.slots.new.tex)
    gl.uniform1i(info.uniforms.u_tex, 0)

    const [bgR, bgG, bgB] = parseBgColorGL(bgColor)
    gl.uniform3f(info.uniforms.u_bgColor, bgR, bgG, bgB)

    this.draw()
  }

  // ─── Cache invalidation ───

  /**
   * Invalidate texture identity cache, forcing re-upload on next render.
   *
   * Does NOT delete the GPU textures — they remain allocated and are
   * overwritten on the next uploadPair/uploadSingle call.
   */
  invalidateTextures(): void {
    for (const s of Object.values(this.slots)) {
      s.input = null
      s.pw = 0
      s.ph = 0
    }
  }

  // ─── Cleanup ───

  /**
   * Release all WebGL resources and remove event listeners.
   *
   * Deletes textures, programs, and the quad buffer. After calling
   * dispose(), this GLRenderer instance must not be used again.
   */
  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)

    if (this.gl && !this.contextLost) {
      const gl = this.gl
      for (const info of Object.values(this.programs)) {
        if (info) gl.deleteProgram(info.program)
      }
      if (this.quadBuf) gl.deleteBuffer(this.quadBuf)
    }

    this.clearSlots()
    this.gl = null
    this.programs = {}
    this.quadBuf = null
    this.lastImgOld = null
    this.lastImgNew = null
    this.lastSingleImg = null
  }
}

/**
 * Lazily create or return an existing GLRenderer for a canvas ref.
 *
 * Used by hooks to avoid creating a new renderer every render cycle.
 * If the canvas element changes (e.g. component remount), the old
 * renderer is disposed and a new one is created.
 */
export function ensureGL(
  ref: React.MutableRefObject<GLRenderer | null>,
  canvas: HTMLCanvasElement,
): GLRenderer {
  if (ref.current && ref.current.canvasElement === canvas) {
    return ref.current
  }
  // Canvas changed or first call — (re)create
  if (ref.current) ref.current.dispose()
  ref.current = new GLRenderer(canvas)
  return ref.current
}
