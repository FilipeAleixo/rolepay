import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { SANS, SERIF } from '../fonts'
import { EASE_IN, EASE_OUT, mix, progress } from '../motion'
import { C, gold, sec } from '../theme'
import { RichText } from './RichText'

/** Fade in at `from`, out at `to` (frames), sliding `dx` pixels sideways on the way in. */
const useInOut = (from: number, to: number, dx = -16) => {
  const frame = useCurrentFrame()
  const a = progress(frame, from, 18, EASE_OUT)
  const b = progress(frame, to - 12, 12, EASE_IN)
  return { opacity: a * (1 - b), transform: `translateX(${mix(a, dx, 0)}px)` }
}

/**
 * The name lower third for the pitch: a gold hairline, the name in Lora, the role in small
 * uppercase. A soft shade behind it keeps it legible over any camera frame.
 */
export const LowerThird: React.FC<{ name?: string; role?: string; from?: number; to?: number }> = ({
  name = 'Filipe Aleixo',
  role = 'Founder',
  from = sec(0.6),
  to = sec(5.2),
}) => {
  const frame = useCurrentFrame()
  const s = useInOut(from, to)
  const line = progress(frame, from, 22, EASE_OUT)
  if (frame > to + 1) return null
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: 1100,
          height: 340,
          background: 'radial-gradient(90% 100% at 0% 100%, rgba(8,9,11,0.72) 0%, rgba(8,9,11,0.35) 45%, transparent 75%)',
          opacity: s.opacity,
        }}
      />
      <div style={{ position: 'absolute', left: 128, bottom: 118, display: 'flex', alignItems: 'stretch', gap: 26, opacity: s.opacity, transform: s.transform }}>
        <div style={{ width: 3, borderRadius: 2, background: C.gold, transform: `scaleY(${line})`, transformOrigin: 'bottom' }} />
        <div>
          <div style={{ font: `400 54px/1.1 ${SERIF}`, color: C.head, letterSpacing: '-0.01em', textShadow: '0 2px 24px rgba(0,0,0,0.5)' }}>{name}</div>
          <div style={{ marginTop: 10, font: `500 19px/1 ${SANS}`, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.soft }}>{role}</div>
        </div>
      </div>
    </AbsoluteFill>
  )
}

/**
 * A few short points over a camera clip, on the right third (the founder sits left of centre):
 * a small uppercase title and up to three lines that arrive one after another.
 */
export const SidePoints: React.FC<{ title: string; points: readonly string[]; from: number; to: number; gap?: number }> = ({ title, points, from, to, gap = sec(0.9) }) => {
  const frame = useCurrentFrame()
  const head = useInOut(from, to, 16)
  if (frame > to + 1) return null
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 900,
          background: 'linear-gradient(270deg, rgba(8,9,11,0.80) 0%, rgba(8,9,11,0.55) 45%, transparent 100%)',
          opacity: head.opacity,
        }}
      />
      <div style={{ position: 'absolute', right: 128, top: 0, bottom: 0, width: 640, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ ...head, display: 'flex', alignItems: 'center', gap: 16, marginBottom: 30 }}>
          <div style={{ width: 32, height: 2, background: gold(0.9), borderRadius: 1 }} />
          <span style={{ font: `500 19px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.soft }}>{title}</span>
        </div>
        {points.map((p, i) => (
          <Point key={i} text={p} from={from + sec(0.35) + i * gap} to={to} />
        ))}
      </div>
    </AbsoluteFill>
  )
}

const Point: React.FC<{ text: string; from: number; to: number }> = ({ text, from, to }) => {
  const s = useInOut(from, to, 16)
  return (
    <div
      style={{
        opacity: s.opacity,
        transform: s.transform,
        padding: '18px 0 20px',
        borderTop: '1px solid rgba(255,255,255,0.10)',
        font: `400 34px/1.3 ${SERIF}`,
        color: C.head,
        textShadow: '0 2px 20px rgba(0,0,0,0.45)',
      }}
    >
      <RichText text={text} />
    </div>
  )
}

/** The lower third over a stand-in frame, for the studio. */
export const LowerThirdPreview: React.FC = () => (
  <AbsoluteFill style={{ background: 'linear-gradient(160deg, #2a2723 0%, #1a1917 60%, #121212 100%)' }}>
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)', font: `500 22px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
      camera
    </AbsoluteFill>
    <LowerThird from={sec(0.3)} to={sec(5.5)} />
  </AbsoluteFill>
)
