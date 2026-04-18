// Design tokens for PixelFoxx
const FX = {
  // Surfaces
  bg:        '#14110E',     // near-black, warm
  surface:   '#1C1916',     // panel bg
  surface2:  '#24211D',     // raised
  surface3:  '#2E2A24',     // hover
  line:      '#3A352D',     // borders
  line2:     '#4A4338',     // active border

  // Text
  text:      '#F4EFE6',     // warm off-white
  textDim:   '#A89E8D',
  textMute:  '#6B6357',

  // Brand (from mascot)
  orange:    '#FF6A1A',
  orangeDk:  '#E5541A',
  yellow:    '#FFC83D',
  blue:      '#4FB3D9',     // fox ear blue, used sparingly

  // Semantic
  ok:        '#7FD46B',
  warn:      '#FFC83D',
  err:       '#FF5A4E',

  // Fonts
  ui:        "'Space Grotesk', system-ui, sans-serif",
  mono:      "'JetBrains Mono', ui-monospace, monospace",
  pixel:     "'Silkscreen', 'Courier New', monospace",
};

// Little pixel-corner clip-path — 3px pixel corners
const PIXEL_CORNERS = 'polygon(0 3px, 3px 3px, 3px 0, calc(100% - 3px) 0, calc(100% - 3px) 3px, 100% 3px, 100% calc(100% - 3px), calc(100% - 3px) calc(100% - 3px), calc(100% - 3px) 100%, 3px 100%, 3px calc(100% - 3px), 0 calc(100% - 3px))';

// Dithered pixel pattern as an svg data-uri — for texture backgrounds
const DITHER_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect width='1' height='1' x='0' y='0' fill='%23ffffff' opacity='0.04'/%3E%3Crect width='1' height='1' x='2' y='2' fill='%23ffffff' opacity='0.04'/%3E%3C/svg%3E")`;

Object.assign(window, { FX, PIXEL_CORNERS, DITHER_BG });
