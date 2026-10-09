import React from 'react'
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { SANS, SERIF } from '../fonts'
import { EASE_IN, enter, mix, progress } from '../motion'
import { C, SAFE, sec, white } from '../theme'
import { Ground } from './Ground'
import { LowerThird } from './Overlays'
import { RichText } from './RichText'
import { Scene } from './Scene'
import { hasAsset } from './Slot'

/**
 * What a camera slot shows when only its voice-over was recorded: the opening (the frame line and
 * the name, over a still portrait when there is one), or the points its camera overlay carries.
 * Lines use RichText: *words* in gold, `words` in monospace.
 */
export type VoiceCardContent =
  | {
      kind: 'opening'
      line: string
      /** A still in video/assets/ under this base name (".jpg", ".jpeg" or ".png"), shown behind the text. */
      portrait?: string
    }
  | { kind: 'points'; title: string; points: readonly string[] }

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'] as const

/** The portrait's file, if one of its extensions is in video/assets/. */
const imageFile = (base: string | undefined) => (base ? (IMAGE_EXTENSIONS.map((e) => base + e).find(hasAsset) ?? null) : null)

/**
 * A full-frame card for the length of the voice-over (the slot is as long as the speech). The
 * points arrive one after another across the speech, so each lands about when it is said, and the
 * card fades out over its last frames like every scene.
 */
export const VoiceCard: React.FC<{ content: VoiceCardContent }> = ({ content }) =>
  content.kind === 'opening' ? <Opening line={content.line} portrait={imageFile(content.portrait)} /> : <Points title={content.title} points={content.points} />

/** When each of `count` points arrives in a card `duration` frames long: evenly over the speech, the last one well before the end. */
const arrivals = (count: number, duration: number) => {
  const first = sec(0.5)
  const tail = Math.max(sec(1.2), Math.round(duration * 0.18))
  const step = Math.max(sec(0.7), (duration - first - tail) / Math.max(1, count))
  return Array.from({ length: count }, (_, i) => Math.round(first + i * step))
}

const Points: React.FC<{ title: string; points: readonly string[] }> = ({ title, points }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const at = arrivals(points.length, durationInFrames)
  return (
    <Scene kicker={title}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 1320 }}>
          {points.map((p, i) => (
            <div
              key={p}
              style={{
                ...enter(frame, at[i] ?? 0, { duration: 24, distance: 14 }),
                display: 'flex',
                alignItems: 'baseline',
                gap: 38,
                padding: '30px 0 32px',
                borderTop: i === 0 ? 'none' : `1px solid ${white(0.08)}`,
              }}
            >
              <span style={{ width: 44, flex: 'none', font: `500 21px/1 ${SANS}`, letterSpacing: '0.12em', color: C.meta, fontVariantNumeric: 'tabular-nums' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ font: `400 58px/1.2 ${SERIF}`, color: C.head, letterSpacing: '-0.012em', textWrap: 'balance' }}>
                <RichText text={p} wholeCode />
              </span>
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </Scene>
  )
}

/**
 * The opening: the frame line, large, on the left, and the name lower third once the speech has
 * started. Behind them the ink ground, or the portrait, slowly pushed in and darkened on the left
 * where the text sits.
 */
const Opening: React.FC<{ line: string; portrait: string | null }> = ({ line, portrait }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const out = 1 - progress(frame, durationInFrames - 12, 12, EASE_IN)
  const nameAt = Math.min(sec(3.5), Math.max(sec(1.2), Math.round(durationInFrames * 0.22)))
  return (
    <AbsoluteFill style={{ backgroundColor: C.ink }}>
      {portrait ? <Portrait file={portrait} /> : <Ground />}
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: 'absolute', left: SAFE.x, top: 0, bottom: 300, width: 1320, display: 'flex', alignItems: 'center' }}>
          <div
            style={{
              ...enter(frame, sec(0.5), { duration: 28, distance: 16 }),
              font: `400 84px/1.18 ${SERIF}`,
              color: C.head,
              letterSpacing: '-0.014em',
              textWrap: 'balance',
              textShadow: portrait ? '0 2px 28px rgba(0,0,0,0.55)' : 'none',
            }}
          >
            <RichText text={line} />
          </div>
        </div>
        <LowerThird from={nameAt} to={durationInFrames + 24} />
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

/** A still, pushed in a little over the card's length, and darkened so the text always reads. */
const Portrait: React.FC<{ file: string }> = ({ file }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const t = progress(frame, 0, durationInFrames, (x) => x)
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: C.ink }}>
      <Img
        src={staticFile(file)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center 35%',
          transform: `scale(${mix(t, 1.04, 1.12)}) translateX(${mix(t, 0, -14)}px)`,
          filter: 'saturate(0.82)',
        }}
      />
      <AbsoluteFill style={{ background: 'rgba(8, 9, 11, 0.42)' }} />
      <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(8,9,11,0.90) 0%, rgba(8,9,11,0.70) 42%, rgba(8,9,11,0.20) 100%)' }} />
      <AbsoluteFill style={{ background: 'linear-gradient(0deg, rgba(8,9,11,0.55) 0%, transparent 40%)' }} />
    </AbsoluteFill>
  )
}
