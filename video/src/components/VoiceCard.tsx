import React from 'react'
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { SANS, SERIF } from '../fonts'
import { enter } from '../motion'
import { C, sec, white } from '../theme'
import { RichText } from './RichText'
import { Scene } from './Scene'
import { hasAsset } from './Slot'

/**
 * What a camera slot shows when only its voice-over was recorded: the points its camera overlay
 * carries, under its title. Lines use RichText: *words* in gold, `words` in monospace.
 */
export type VoiceCardContent = {
  kind: 'points'
  title: string
  points: readonly string[]
  /** A photo beside the points, a file in video/assets/ (left out while it is missing). */
  photo?: string
  /** Short lines under the photo, such as profile addresses. */
  links?: readonly string[]
}

/**
 * A full-frame card for the length of the voice-over (the slot is as long as the speech). The
 * points arrive one after another across the speech, so each lands about when it is said, and the
 * text clears just before the card ends, so the cut to the next item never shows both.
 */
export const VoiceCard: React.FC<{ content: VoiceCardContent }> = ({ content }) => (
  <Points title={content.title} points={content.points} photo={content.photo && hasAsset(content.photo) ? content.photo : null} links={content.links ?? []} />
)

/** The card's text is gone this long before its end, so the crossfade into the next item is clean. */
export const CLEAR_BY = 8

/** When each of `count` points arrives in a card `duration` frames long: evenly over the speech, the last one well before the end. */
const arrivals = (count: number, duration: number) => {
  const first = sec(0.5)
  const tail = Math.max(sec(1.2), Math.round(duration * 0.18))
  const step = Math.max(sec(0.7), (duration - first - tail) / Math.max(1, count))
  return Array.from({ length: count }, (_, i) => Math.round(first + i * step))
}

const Points: React.FC<{ title: string; points: readonly string[]; photo: string | null; links: readonly string[] }> = ({ title, points, photo, links }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const at = arrivals(points.length, durationInFrames)
  // More than three points (a list slide) take smaller type and less air, so six still fit the frame.
  const dense = points.length > 3
  return (
    <Scene kicker={title} exitFrames={14} clearBy={CLEAR_BY}>
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 72 }}>
        {photo ? (
          <div style={{ ...enter(frame, 0, { duration: 24, distance: 14 }), display: 'flex', flexDirection: 'column', gap: 26 }}>
            <Img src={staticFile(photo)} style={{ width: 380, height: 380, objectFit: 'cover', borderRadius: 28, boxShadow: `0 0 0 1px ${white(0.1)}` }} />
            {links.map((l) => (
              <div key={l} style={{ font: `500 25px/1 ${SANS}`, color: C.meta, letterSpacing: '0.01em' }}>
                {l}
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ width: photo ? 900 : 1320 }}>
          {points.map((p, i) => (
            <div
              key={p}
              style={{
                ...enter(frame, at[i] ?? 0, { duration: 24, distance: 14 }),
                display: 'flex',
                alignItems: 'baseline',
                gap: 38,
                padding: dense ? '17px 0 19px' : '30px 0 32px',
                borderTop: i === 0 ? 'none' : `1px solid ${white(0.08)}`,
              }}
            >
              <span style={{ width: 44, flex: 'none', font: `500 21px/1 ${SANS}`, letterSpacing: '0.12em', color: C.meta, fontVariantNumeric: 'tabular-nums' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ font: `400 ${dense ? (photo ? 40 : 44) : 58}px/1.2 ${SERIF}`, color: C.head, letterSpacing: '-0.012em', textWrap: 'balance' }}>
                <RichText text={p} wholeCode />
              </span>
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </Scene>
  )
}
