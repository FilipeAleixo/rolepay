import React from 'react'
import { AbsoluteFill } from 'remotion'
import { Ground } from '../components/Ground'
import { Mark } from '../components/Mark'
import { SANS, SERIF } from '../fonts'
import { EASE_OUT, mix } from '../motion'
import { C } from '../theme'

/** Fade in while rising a little, from `start` over `duration` seconds. */
const rise = (t: number, start: number, unit: number, duration = 0.6) => {
  const p = EASE_OUT(Math.min(1, Math.max(0, (t - start) / duration)))
  return { opacity: p, transform: `translateY(${mix(p, 12 * unit, 0)}px)` }
}

const Lockup: React.FC<{ t: number; unit: number; size: number }> = ({ t, unit, size }) => {
  const mark = EASE_OUT(Math.min(1, Math.max(0, t / 0.5)))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.3 }}>
      <Mark size={size} tile={mark} outline={1} fill={mark} face={mark} />
      <span style={{ ...rise(t, 0.12, unit), font: `400 ${size * 0.9}px/1 ${SERIF}`, letterSpacing: '-0.015em', color: C.head }}>Rolepay</span>
    </div>
  )
}

/**
 * The title card, `t` seconds in, at `unit` (1 for 1920 by 1080): the lockup, the promise, and
 * what the recording is.
 */
export const TitleCard: React.FC<{ t: number; unit: number }> = ({ t, unit }) => (
  <Ground>
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `translateY(${-14 * unit}px)` }}>
        <Lockup t={t} unit={unit} size={112 * unit} />
        <div style={{ ...rise(t, 0.35, unit), marginTop: 58 * unit, font: `400 ${48 * unit}px/1.3 ${SANS}`, color: C.fg }}>
          Pay the people who run your community, <span style={{ color: C.gold }}>from Discord</span>.
        </div>
        <div style={{ ...rise(t, 0.6, unit), marginTop: 30 * unit, display: 'flex', alignItems: 'center', gap: 16 * unit }}>
          <div style={{ width: 30 * unit, height: Math.max(1, 2 * unit), borderRadius: 1, background: C.periwinkle, opacity: 0.85 }} />
          <span style={{ font: `500 ${22 * unit}px/1 ${SANS}`, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.meta }}>A real pay run on Tempo mainnet</span>
          <div style={{ width: 30 * unit, height: Math.max(1, 2 * unit), borderRadius: 1, background: C.periwinkle, opacity: 0.85 }} />
        </div>
      </div>
    </AbsoluteFill>
  </Ground>
)

/** The end card: the lockup, (on X) the promise again, and where to try it. */
export const EndCard: React.FC<{ t: number; unit: number; promise: boolean }> = ({ t, unit, promise }) => (
  <Ground>
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `translateY(${-10 * unit}px)` }}>
        <Lockup t={t} unit={unit} size={100 * unit} />
        {promise ? <div style={{ ...rise(t, 0.3, unit), marginTop: 54 * unit, font: `400 ${46 * unit}px/1.3 ${SANS}`, color: C.fg }}>Pay the people who run your community.</div> : null}
        <div style={{ ...rise(t, promise ? 0.55 : 0.3, unit), marginTop: (promise ? 46 : 58) * unit, font: `400 ${34 * unit}px/1.3 ${SANS}`, color: C.soft }}>Try it on the demo</div>
        <div style={{ ...rise(t, promise ? 0.7 : 0.45, unit), marginTop: 14 * unit, font: `500 ${52 * unit}px/1.1 ${SANS}`, letterSpacing: '0.005em', color: C.gold }}>demo.rolepay.app</div>
      </div>
    </AbsoluteFill>
  </Ground>
)
