import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { SANS } from '../fonts'
import { EASE_IN, progress } from '../motion'
import { C, SAFE, gold } from '../theme'
import { Ground } from './Ground'

/**
 * Every explainer scene: the ink ground, an optional kicker label top left, and the content, which
 * fades out over the last frames so a scene can be cut anywhere (the ground stays). With `clearBy`,
 * the content is gone that many frames before the end, so a crossfade into the next item shows the
 * ground and the next item's content arriving, never two sets of text over each other.
 */
export const Scene: React.FC<{ kicker?: string; children: React.ReactNode; exitFrames?: number; clearBy?: number }> = ({ kicker, children, exitFrames = 12, clearBy = 0 }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const out = 1 - progress(frame, durationInFrames - clearBy - exitFrames, exitFrames, EASE_IN)
  return (
    <Ground>
      <AbsoluteFill style={{ opacity: out }}>
        {kicker ? <Kicker text={kicker} /> : null}
        {children}
      </AbsoluteFill>
    </Ground>
  )
}

/** The small uppercase label, as the pages' section labels: a short gold rule, then the words. */
export const Kicker: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame()
  const t = progress(frame, 2, 20)
  return (
    <div
      style={{
        position: 'absolute',
        left: SAFE.x,
        top: SAFE.y,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        opacity: t,
      }}
    >
      <div style={{ width: 36 * t, height: 2, background: gold(0.9), borderRadius: 1 }} />
      <span style={{ font: `500 19px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.meta }}>{text}</span>
    </div>
  )
}
