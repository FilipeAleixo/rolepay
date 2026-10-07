import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { Mark } from '../components/Mark'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { enter, progress } from '../motion'
import { C, sec, white } from '../theme'

export const END_CARD_FRAMES = sec(5)

/** 10. End card: the lockup, where to find it, and what it was built for. */
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame()
  const mark = progress(frame, 0, 18)
  return (
    <Scene exitFrames={0}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
            <Mark size={128} tile={mark} outline={1} fill={mark} face={mark} />
            <span style={{ ...enter(frame, 8, { duration: 22, distance: 10 }), font: `400 112px/1 ${SERIF}`, letterSpacing: '-0.015em', color: C.head }}>Rolepay</span>
          </div>
          <div style={{ ...enter(frame, 24, { distance: 10 }), marginTop: 64, font: `500 40px/1 ${SANS}`, color: C.gold, letterSpacing: '0.01em' }}>demo.rolepay.app</div>
          <div style={{ ...enter(frame, 32, { distance: 10 }), marginTop: 22, font: `400 30px/1 ${SANS}`, color: C.fg }}>github.com/FilipeAleixo/rolepay</div>
          <div style={{ ...enter(frame, 44, { distance: 8 }), marginTop: 64, paddingTop: 28, borderTop: `1px solid ${white(0.1)}`, font: `400 24px/1.3 ${SANS}`, color: C.meta, textAlign: 'center' }}>
            Built for Colosseum's Crypto World's Fair, Tempo track
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  )
}
