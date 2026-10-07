import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { SANS } from '../fonts'
import { EASE_IN, EASE_OUT, mix, progress } from '../motion'
import { C, sec } from '../theme'
import { RichText } from './RichText'

/** One caption on a recording: from `at` to `until`, in seconds from the start of its clip. */
export type CaptionCue = { at: number; until: number; text: string }

/**
 * A caption for a screen recording: white on a soft dark panel near the bottom, one keyword in
 * gold (*like this*). It fades and rises a few pixels in, and fades out. Keep it to one line.
 */
export const Caption: React.FC<{ text: string; from: number; to: number; bottom?: number }> = ({ text, from, to, bottom = 64 }) => {
  const frame = useCurrentFrame()
  if (frame < from - 1 || frame > to + 1) return null
  const a = progress(frame, from, 14, EASE_OUT)
  const b = progress(frame, to - 10, 10, EASE_IN)
  const opacity = a * (1 - b)
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          marginBottom: bottom,
          maxWidth: 1480,
          padding: '20px 34px 22px',
          borderRadius: 16,
          background: 'rgba(11, 12, 15, 0.80)',
          backdropFilter: 'blur(14px)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 24px 60px -28px rgba(0,0,0,0.9)',
          opacity,
          transform: `translateY(${mix(a, 12, 0)}px)`,
          font: `500 36px/1.3 ${SANS}`,
          letterSpacing: '-0.003em',
          color: '#FFFFFF',
          textAlign: 'center',
        }}
      >
        <RichText text={text} />
      </div>
    </AbsoluteFill>
  )
}

/** Every cue of a clip, timed in seconds from the clip's start. */
export const Captions: React.FC<{ cues: readonly CaptionCue[] }> = ({ cues }) => (
  <>
    {cues.map((c, i) => (
      <Caption key={i} text={c.text} from={sec(c.at)} to={sec(c.until)} />
    ))}
  </>
)

/** A caption preview over a stand-in frame, for the studio. */
export const CaptionPreview: React.FC = () => (
  <AbsoluteFill style={{ background: 'linear-gradient(180deg, #1b1d22, #121317)' }}>
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', color: C.meta, font: `500 22px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
      a screen recording plays here
    </AbsoluteFill>
    <Captions
      cues={[
        { at: 0.3, until: 3.6, text: 'Paid in *one batched transaction*, one memo per line' },
        { at: 3.9, until: 7.6, text: '`/rolepay new` builds a run for a *role*' },
      ]}
    />
  </AbsoluteFill>
)
