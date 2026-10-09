/**
 * The product's "ink" design, as the video uses it. Values mirror packages/web/src/views/theme.ts
 * (the --ink, --head, --fg, --soft, --meta tokens and the gold of the mark), so the films and the
 * pages read as one thing. Gold is the accent (the periwinkle, the pages' second, only marks the
 * steps and the Discord side in the short cuts); the maroon appears only inside the mark.
 */
export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080

/** Seconds to frames at the project frame rate. */
export const sec = (s: number) => Math.round(s * FPS)

export const C = {
  ink: '#0B0C0F',
  head: '#F2F1EE',
  fg: '#E8E7E4',
  soft: '#B9B8B4',
  meta: '#94938F',
  muted: '#8A8985',
  gold: '#EDBE5A',
  // The pages' second accent (--accent-2), the cool one: step numbers and small labels, never on
  // the same small element as gold.
  periwinkle: '#8F9CFF',
  maroon: '#4A1B2A',
  // Status colours, for small marks only (a held line's dot), as on the dashboard.
  warn: '#E2B26E',
  ok: '#8CCB9E',
} as const

export const gold = (alpha: number) => `rgba(237, 190, 90, ${alpha})`
export const white = (alpha: number) => `rgba(255, 255, 255, ${alpha})`

/** A panel: a near-black wash with a hairline of light along its top edge, never a box. */
export const panel = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.034) 0%, rgba(255,255,255,0.018) 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.075), 0 40px 80px -48px rgba(0,0,0,0.95)',
  borderRadius: 22,
} as const

/** Safe margins for 1920 by 1080: text stays inside these. */
export const SAFE = { x: 160, y: 112 } as const
