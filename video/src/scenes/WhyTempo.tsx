import React from 'react'
import { useCurrentFrame } from 'remotion'
import { FingerprintIcon, KeyIcon, MemoIcon, NoGasIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, progress } from '../motion'
import { C, gold, sec, white } from '../theme'

export const WHY_TEMPO_FRAMES = sec(8)

/** 9. Why Tempo: the four protocol features Rolepay is built on, as README.md states them. */
const POINTS = [
  { Icon: KeyIcon, title: 'Access keys', body: 'Limits per period, enforced by the protocol, even inside a batch.' },
  { Icon: FingerprintIcon, title: 'Passkey accounts', body: "The treasury's root key is a passkey. Recipients need no wallet and no seed phrase." },
  { Icon: MemoIcon, title: "Memo'd stablecoin transfers", body: 'Every payout line carries its run and line number.' },
  { Icon: NoGasIcon, title: 'Fee sponsorship', body: 'Recipients never need gas to be paid.' },
] as const

const CELL_W = 760
const COL_X = [160, 1000] as const
const ROW_Y = [290, 604] as const

export const WhyTempo: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <Scene kicker="Why Tempo">
      {POINTS.map(({ Icon, title, body }, i) => {
        const at = 10 + i * 14
        const x = COL_X[i % 2] ?? 0
        const y = ROW_Y[Math.floor(i / 2)] ?? 0
        return (
          <div key={title} style={{ position: 'absolute', left: x, top: y, width: CELL_W, display: 'flex', gap: 34, paddingTop: 34, borderTop: `1px solid ${white(0.1)}`, ...enter(frame, at, { distance: 12 }) }}>
            <div style={{ width: 84, height: 84, flex: 'none', borderRadius: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', background: gold(0.06), boxShadow: `inset 0 0 0 1.5px ${gold(0.45)}` }}>
              <Icon size={40} color={C.gold} strokeWidth={1.45} draw={progress(frame, at + 2, 24, EASE_IN_OUT)} />
            </div>
            <div style={{ paddingTop: 4 }}>
              <div style={{ font: `400 46px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>{title}</div>
              <div style={{ marginTop: 16, font: `400 26px/1.45 ${SANS}`, color: C.soft, maxWidth: 600 }}>{body}</div>
            </div>
          </div>
        )
      })}
    </Scene>
  )
}
