// ─── Application constants ───

// View defaults
export const DEFAULT_ZOOM = 100
export const DEFAULT_FADE = 85
export const DEFAULT_THRESH = 25
export const DEFAULT_OVERLAY = 50
export const DEFAULT_BG_COLOR = '#ffffff'

// Zoom range & steps
export const ZOOM_MIN = 10
export const ZOOM_MAX = 1000
export const ZOOM_STEP_SMALL = 10
export const ZOOM_STEP_MEDIUM = 20
export const ZOOM_STEP_LARGE = 50
export const ZOOM_TIER_MEDIUM = 100
export const ZOOM_TIER_LARGE = 300

// KiCad layer order (supports both KiCad 9 long names and legacy short names)
export const KICAD_LAYER_ORDER: string[] = [
  // Copper
  'F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu',
  'In7.Cu', 'In8.Cu', 'In9.Cu', 'In10.Cu', 'In11.Cu', 'In12.Cu',
  'In13.Cu', 'In14.Cu', 'In15.Cu', 'In16.Cu', 'In17.Cu', 'In18.Cu',
  'In19.Cu', 'In20.Cu', 'In21.Cu', 'In22.Cu', 'In23.Cu', 'In24.Cu',
  'In25.Cu', 'In26.Cu', 'In27.Cu', 'In28.Cu', 'In29.Cu', 'In30.Cu', 'B.Cu',
  // Adhesive (KiCad 9 / legacy)
  'F.Adhesive', 'F.Adhes', 'B.Adhesive', 'B.Adhes',
  // Paste
  'F.Paste', 'B.Paste',
  // Silkscreen (KiCad 9 / legacy)
  'F.Silkscreen', 'F.SilkS', 'B.Silkscreen', 'B.SilkS',
  // Mask
  'F.Mask', 'B.Mask',
  // User/Drawing (KiCad 9 / legacy)
  'User.Drawings', 'Dwgs.User', 'User.Comments', 'Cmts.User',
  'User.Eco1', 'Eco1.User', 'User.Eco2', 'Eco2.User',
  // Misc
  'Margin',
  // Courtyard (KiCad 9 / legacy)
  'F.Courtyard', 'F.CrtYd', 'B.Courtyard', 'B.CrtYd',
  // Fabrication
  'F.Fab', 'B.Fab',
  // User layers
  'User.1', 'User.2', 'User.3', 'User.4', 'User.5',
  'User.6', 'User.7', 'User.8', 'User.9',
]
export const KICAD_LAYER_INDEX: Record<string, number> = Object.fromEntries(
  KICAD_LAYER_ORDER.map((name, i) => [name, i]),
)

// Rendering
export const FADE_BG: [number, number, number] = [15, 15, 35]
export const HI_RES_DEBOUNCE_MS = 150
export const CHANGE_DETECT_SAMPLE_SIZE = 128
export const LAYER_ALPHA = 0.4

// Dominant-colour detection (fill-area background)
export const DOM_COLOR_SAMPLE_SIZE = 64
export const DOM_COLOR_AREA_THRESH = 0.20
export const DOM_COLOR_MATCH_THRESH = 0.10
