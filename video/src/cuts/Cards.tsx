import React from 'react'
import { AbsoluteFill } from 'remotion'
import { Ground } from '../components/Ground'
import { Mark } from '../components/Mark'
import { SANS, SERIF } from '../fonts'
import { enter, progress } from '../motion'
import { C } from '../theme'

/**
 * The cards around the X cut, at 1920 by 1080: a short, calm title (the lockup and what the
 * recording is), and the end card (the lockup, the promise, where to try it). Each takes the frame
 * from its own start, since the cut places them.
 */
export const TitleCard: React.FC<{ frame: number }> = ({ frame }) => {
  const mark = progress(frame, 0, 14)
  return (
    <Ground>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
            <Mark size={112} tile={mark} outline={1} fill={mark} face={mark} />
            <span style={{ ...enter(frame, 3, { duration: 18, distance: 10 }), font: `400 104px/1 ${SERIF}`, letterSpacing: '-0.015em', color: C.head }}>Rolepay</span>
          </div>
          <div style={{ ...enter(frame, 9, { duration: 18, distance: 10 }), marginTop: 52, font: `400 44px/1.3 ${SANS}`, color: C.fg }}>
            A real pay run on <span style={{ color: C.gold }}>Tempo mainnet</span>
          </div>
        </div>
      </AbsoluteFill>
    </Ground>
  )
}

export const EndCard: React.FC<{ frame: number }> = ({ frame }) => {
  const mark = progress(frame, 0, 18)
  return (
    <Ground>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
            <Mark size={128} tile={mark} outline={1} fill={mark} face={mark} />
            <span style={{ ...enter(frame, 6, { duration: 22, distance: 10 }), font: `400 112px/1 ${SERIF}`, letterSpacing: '-0.015em', color: C.head }}>Rolepay</span>
          </div>
          <div style={{ ...enter(frame, 16, { distance: 10 }), marginTop: 60, font: `400 48px/1.3 ${SANS}`, color: C.fg }}>Pay the people who run your community.</div>
          <div style={{ ...enter(frame, 26, { distance: 10 }), marginTop: 40, font: `500 42px/1 ${SANS}`, color: C.gold, letterSpacing: '0.01em' }}>demo.rolepay.app</div>
        </div>
      </AbsoluteFill>
    </Ground>
  )
}
