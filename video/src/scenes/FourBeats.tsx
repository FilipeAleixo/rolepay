import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { BlocksIcon, CodeIcon, PersonIcon, SparkIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, progress } from '../motion'
import { C, gold, sec, white } from '../theme'

export const FOUR_BEATS_FRAMES = sec(10)

const BEATS = [
  { Icon: SparkIcon, lines: ['AI writes', 'the rule once.'] },
  { Icon: PersonIcon, lines: ['Humans', 'approve it.'] },
  { Icon: CodeIcon, lines: ['Code', 'runs it.'] },
  { Icon: BlocksIcon, lines: ['The chain', 'caps it.'] },
] as const

const START = 14
const GAP = 40 // frames between beats
const COL = 360
const SPACE = 40
const LEFT = (1920 - (BEATS.length * COL + (BEATS.length - 1) * SPACE)) / 2
const ICON_Y = 362
const RING = 112

/** 4. "AI writes the rule once. Humans approve it. Code runs it. The chain caps it." */
export const FourBeats: React.FC = () => {
  const frame = useCurrentFrame()
  const joined = START + BEATS.length * GAP + 4
  const line = progress(frame, joined, 30, EASE_IN_OUT)
  const first = LEFT + COL / 2 + RING / 2
  const last = LEFT + (BEATS.length - 1) * (COL + SPACE) + COL / 2 - RING / 2
  return (
    <Scene kicker="Standing policies">
      <AbsoluteFill>
        {/* The four beats join into one line. */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          {BEATS.slice(0, -1).map((_, i) => {
            const x1 = LEFT + i * (COL + SPACE) + COL / 2 + RING / 2 + 10
            const x2 = LEFT + (i + 1) * (COL + SPACE) + COL / 2 - RING / 2 - 10
            const head = first + line * (last - first)
            if (head <= x1) return null
            return <line key={i} x1={x1} y1={ICON_Y} x2={Math.min(head, x2)} y2={ICON_Y} stroke={gold(0.6)} strokeWidth={1.5} strokeLinecap="round" />
          })}
        </svg>
        {BEATS.map(({ Icon, lines }, i) => {
          const at = START + i * GAP
          const x = LEFT + i * (COL + SPACE)
          return (
            <div key={lines[0]} style={{ position: 'absolute', left: x, width: COL, top: ICON_Y - RING / 2, textAlign: 'center' }}>
              <div
                style={{
                  ...enter(frame, at, { duration: 20, distance: 12 }),
                  width: RING,
                  height: RING,
                  margin: '0 auto',
                  borderRadius: RING / 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: gold(0.06),
                  boxShadow: `inset 0 0 0 1.5px ${gold(0.5)}`,
                }}
              >
                <Icon size={50} color={C.gold} strokeWidth={1.4} draw={progress(frame, at + 2, 24, EASE_IN_OUT)} />
              </div>
              <div style={{ ...enter(frame, at + 8, { duration: 20, distance: 14 }), marginTop: 44, font: `400 50px/1.18 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
                {lines[0]}
                <br />
                {lines[1]}
              </div>
            </div>
          )
        })}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 742,
            textAlign: 'center',
            ...enter(frame, joined + 24, { duration: 22, distance: 10 }),
          }}
        >
          <span style={{ display: 'inline-block', padding: '14px 30px', borderRadius: 999, boxShadow: `inset 0 0 0 1px ${white(0.12)}`, font: `400 27px/1.2 ${SANS}`, color: C.soft }}>
            No AI at runtime. Every run is capped by the bot key, on chain.
          </span>
        </div>
      </AbsoluteFill>
    </Scene>
  )
}
