import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { Mark } from '../components/Mark'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, progress } from '../motion'
import { C, sec } from '../theme'

export const TITLE_FRAMES = sec(4)

/** 1. Title: the mark draws in, then "Rolepay", then the one-line promise. */
export const Title: React.FC = () => {
  const frame = useCurrentFrame()
  const tile = progress(frame, 0, 16)
  const outline = progress(frame, 5, 26, EASE_IN_OUT)
  const fill = progress(frame, 24, 14)
  const face = progress(frame, 32, 12)
  return (
    <Scene>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                inset: -140,
                background: 'radial-gradient(closest-side, rgba(237,190,90,0.10), transparent)',
                opacity: fill,
              }}
            />
            <Mark size={168} tile={tile} outline={outline} fill={fill} face={face} style={{ position: 'relative' }} />
          </div>
          <div style={{ ...enter(frame, 38, { duration: 22, distance: 14 }), marginTop: 46 }}>
            <span style={{ font: `400 128px/1 ${SERIF}`, letterSpacing: '-0.015em', color: C.head }}>Rolepay</span>
          </div>
          <div style={{ marginTop: 44, textAlign: 'center' }}>
            <div style={{ ...enter(frame, 54, { duration: 20, distance: 12 }), font: `400 40px/1.35 ${SANS}`, color: C.fg }}>
              Pay the people who run your community, from Discord.
            </div>
            <div style={{ ...enter(frame, 62, { duration: 20, distance: 12 }), font: `400 40px/1.35 ${SANS}`, color: C.gold, marginTop: 6 }}>
              In stablecoins, on Tempo.
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  )
}
