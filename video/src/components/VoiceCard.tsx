import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { SANS, SERIF } from '../fonts'
import { enter } from '../motion'
import { C, sec, white } from '../theme'
import { RichText } from './RichText'
import { Scene } from './Scene'

/**
 * What a camera slot shows when only its voice-over was recorded: the points its camera overlay
 * carries, under its title. Lines use RichText: *words* in gold, `words` in monospace.
 */
export type VoiceCardContent = { kind: 'points'; title: string; points: readonly string[] }

/**
 * A full-frame card for the length of the voice-over (the slot is as long as the speech). The
 * points arrive one after another across the speech, so each lands about when it is said, and the
 * text clears just before the card ends, so the cut to the next item never shows both.
 */
export const VoiceCard: React.FC<{ content: VoiceCardContent }> = ({ content }) => <Points title={content.title} points={content.points} />

/** The card's text is gone this long before its end, so the crossfade into the next item is clean. */
export const CLEAR_BY = 8

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
    <Scene kicker={title} exitFrames={14} clearBy={CLEAR_BY}>
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
