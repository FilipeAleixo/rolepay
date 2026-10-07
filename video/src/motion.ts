/**
 * The one motion vocabulary: ease-outs, short fades and short slides. Nothing bounces, nothing
 * overshoots, nothing flashes. Every scene builds its timing from these helpers.
 */
import { Easing, interpolate } from 'remotion'

/** A long, soft ease-out (close to easeOutQuint): arrives quickly, settles slowly. */
export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1)
/** For things that travel (a line drawing, a dot moving): even in, soft out. */
export const EASE_IN_OUT = Easing.bezier(0.45, 0, 0.25, 1)
export const EASE_IN = Easing.bezier(0.5, 0, 0.75, 0)

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/** 0 before `start`, 1 after `start + duration`, eased in between. */
export const progress = (frame: number, start: number, duration: number, easing = EASE_OUT) =>
  interpolate(frame, [start, start + Math.max(1, duration)], [0, 1], { ...clamp, easing })

/** Maps a 0..1 progress onto a range. */
export const mix = (t: number, from: number, to: number) => from + (to - from) * t

/** Fade in while sliding up a little: the default entrance. */
export const enter = (frame: number, start: number, opts: { duration?: number; distance?: number } = {}) => {
  const t = progress(frame, start, opts.duration ?? 18)
  return { opacity: t, transform: `translateY(${mix(t, opts.distance ?? 18, 0)}px)` }
}

/** Fade out while drifting up a little: the default exit. */
export const leave = (frame: number, start: number, opts: { duration?: number; distance?: number } = {}) => {
  const t = progress(frame, start, opts.duration ?? 12, EASE_IN)
  return { opacity: 1 - t, transform: `translateY(${mix(t, 0, -(opts.distance ?? 10))}px)` }
}

/** Visible from `start` to `end` (frames), with an entrance and an exit. */
export const during = (frame: number, start: number, end: number, opts: { duration?: number; distance?: number } = {}) => {
  const a = progress(frame, start, opts.duration ?? 18)
  const b = progress(frame, end - 12, 12, EASE_IN)
  return { opacity: a * (1 - b), transform: `translateY(${mix(a, opts.distance ?? 18, 0) - 10 * b}px)` }
}
