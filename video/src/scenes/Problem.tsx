import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { during, enter, leave } from '../motion'
import { C, sec, white } from '../theme'

export const PROBLEM_FRAMES = sec(8.5)

const BEAT_2 = sec(2.7)
const BEAT_3 = sec(5.6)

const PAINS = ['One wallet send at a time.', 'A spreadsheet.', 'Recipients who need gas.', 'No clean record.'] as const

/** 2. The problem, in three short beats. */
export const Problem: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <Scene kicker="The problem">
      {/* Beat 1: who gets paid. */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...during(frame, 6, BEAT_2), textAlign: 'center', font: `400 76px/1.22 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
          Communities pay moderators, staff
          <br />
          and bounty winners every month.
        </div>
      </AbsoluteFill>

      {/* Beat 2: how it is done today, one fragment at a time. */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 860, ...leave(frame, BEAT_3 - 12) }}>
          {PAINS.map((p, i) => (
            <div
              key={p}
              style={{
                ...enter(frame, BEAT_2 + 4 + i * 11, { duration: 16, distance: 14 }),
                display: 'flex',
                alignItems: 'center',
                gap: 34,
                padding: '22px 0',
                borderTop: i === 0 ? 'none' : `1px solid ${white(0.07)}`,
              }}
            >
              <span style={{ width: 40, font: `500 20px/1 ${SANS}`, letterSpacing: '0.12em', color: C.meta, fontVariantNumeric: 'tabular-nums' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ font: `400 50px/1.15 ${SERIF}`, color: C.fg, letterSpacing: '-0.01em' }}>{p}</span>
            </div>
          ))}
        </div>
      </AbsoluteFill>

      {/* Beat 3: the real risk. */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...enter(frame, BEAT_3, { duration: 22, distance: 16 }), textAlign: 'center', font: `400 84px/1.2 ${SERIF}`, color: C.head, letterSpacing: '-0.014em' }}>
          And whoever holds the keys
          <br />
          holds <span style={{ color: C.gold }}>all the money.</span>
        </div>
      </AbsoluteFill>
    </Scene>
  )
}
