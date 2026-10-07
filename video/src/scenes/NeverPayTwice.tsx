import React from 'react'
import { useCurrentFrame } from 'remotion'
import { CheckIcon, ClockIcon, MemoIcon, ShieldIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, mix, progress } from '../motion'
import { C, gold, panel, sec, white } from '../theme'

export const NEVER_PAY_TWICE_FRAMES = sec(7)

/*
 * 6. Never pays twice. Two workers reach for the same approved run (as on the demo on 2026-10-07:
 * the Approve job and the 30-second recovery sweep). A compare-and-set on the run's version lets
 * one move it to executing; the other gets concurrent_update and sends nothing. Then the three
 * facts behind every attempt, from "Never pay twice" in docs/ARCHITECTURE.md.
 */

const WORKER_Y = 276
const RUN_Y = 460
const LEFT_X = 520
const RIGHT_X = 1400
const RUN_X = 960

const T = { workers: 8, reach: 22, win: 50, facts: [104, 118, 132] as const }

const FACTS = [
  { Icon: ShieldIcon, text: 'Signed before broadcast' },
  { Icon: ClockIcon, text: 'A deadline on every attempt' },
  { Icon: MemoIcon, text: 'Memo checked before any retry' },
] as const

export const NeverPayTwice: React.FC = () => {
  const frame = useCurrentFrame()
  const reach = progress(frame, T.reach, 22, EASE_IN_OUT)
  const won = progress(frame, T.win, 14)
  return (
    <Scene kicker="Never pays twice">
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        {/* The two workers reach for the run. */}
        {[LEFT_X, RIGHT_X].map((x, i) => {
          const x1 = x + (i === 0 ? 156 : -156)
          const x2 = mix(reach, x1, RUN_X + (i === 0 ? -150 : 150))
          const y2 = mix(reach, WORKER_Y, RUN_Y - 48)
          const loser = i === 1
          return (
            <line
              key={x}
              x1={x1}
              y1={WORKER_Y}
              x2={x2}
              y2={y2}
              stroke={loser ? white(0.22 - 0.12 * won) : gold(0.4 + 0.3 * won)}
              strokeWidth={1.5}
              strokeDasharray={loser ? '3 7' : undefined}
              strokeLinecap="round"
              opacity={reach > 0 ? 1 : 0}
            />
          )
        })}
      </svg>

      <Worker x={LEFT_X} name="Approve job" result="moves it, sends once" frame={frame} won={won} winner />
      <Worker x={RIGHT_X} name="Recovery sweep" result="concurrent_update, sends nothing" frame={frame} won={won} />

      {/* The run, and its version. */}
      <div
        style={{
          position: 'absolute',
          left: RUN_X - 300,
          width: 600,
          top: RUN_Y - 48,
          height: 96,
          ...panel,
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 22,
          ...enter(frame, T.workers + 6),
        }}
      >
        <span style={{ font: `500 17px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.meta }}>Run</span>
        <span style={{ position: 'relative', width: 340, height: 44 }}>
          <State text="approved · v3" opacity={1 - won} y={-10 * won} />
          <State text="executing · v4" opacity={won} y={10 * (1 - won)} gold />
        </span>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: RUN_Y + 74, textAlign: 'center', font: `400 24px/1.4 ${SANS}`, color: C.soft, ...enter(frame, T.win + 10, { distance: 8 }) }}>
        Compare-and-set on the run's version: one attempt wins, the other sends nothing.
      </div>

      {/* The three facts behind every attempt. */}
      <div style={{ position: 'absolute', left: 160, right: 160, top: 740, display: 'flex', justifyContent: 'space-between' }}>
        {FACTS.map(({ Icon, text }, i) => (
          <div key={text} style={{ width: 480, display: 'flex', alignItems: 'center', gap: 22, paddingTop: 26, borderTop: `1px solid ${white(0.1)}`, ...enter(frame, T.facts[i] ?? 0, { distance: 10 }) }}>
            <div style={{ width: 60, height: 60, borderRadius: 30, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: gold(0.06), boxShadow: `inset 0 0 0 1.5px ${gold(0.45)}` }}>
              <Icon size={30} color={C.gold} strokeWidth={1.5} />
            </div>
            <span style={{ font: `400 34px/1.2 ${SERIF}`, color: C.head, letterSpacing: '-0.01em' }}>{text}</span>
          </div>
        ))}
      </div>
    </Scene>
  )
}

const State: React.FC<{ text: string; opacity: number; y: number; gold?: boolean }> = ({ text, opacity, y, gold: isGold }) => (
  <span
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: `400 40px/1 ${SERIF}`,
      color: isGold ? C.gold : C.head,
      opacity,
      transform: `translateY(${y}px)`,
      whiteSpace: 'nowrap',
    }}
  >
    {text}
  </span>
)

const Worker: React.FC<{ x: number; name: string; result: string; frame: number; won: number; winner?: boolean }> = ({ x, name, result, frame, won, winner }) => (
  <div style={{ position: 'absolute', left: x - 260, width: 520, top: WORKER_Y - 40, textAlign: 'center', ...enter(frame, T.workers) }}>
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        height: 80,
        padding: '0 30px',
        borderRadius: 40,
        background: white(0.03),
        boxShadow: `inset 0 0 0 1.5px ${winner ? gold(0.2 + 0.3 * won) : white(0.12)}`,
        font: `500 27px/1 ${SANS}`,
        color: winner || won < 0.5 ? C.head : C.meta,
      }}
    >
      {winner ? <CheckIcon size={26} color={C.gold} strokeWidth={2} draw={won} style={{ marginLeft: -4 }} /> : null}
      {name}
    </div>
    <div style={{ marginTop: 16, height: 26, font: `400 ${winner ? 21 : 19}px/1.2 ${winner ? SANS : 'ui-monospace, SFMono-Regular, Menlo, monospace'}`, color: winner ? C.gold : C.meta, opacity: won }}>{result}</div>
  </div>
)
