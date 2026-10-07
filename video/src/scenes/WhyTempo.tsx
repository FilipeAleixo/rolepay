import React from 'react'
import { useCurrentFrame } from 'remotion'
import { DepositIcon, FingerprintIcon, KeyIcon, MemoIcon, NoGasIcon, SwapIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, progress } from '../motion'
import { C, gold, sec, white } from '../theme'

export const WHY_TEMPO_FRAMES = sec(10)

/**
 * 9. Why Tempo: the six protocol features Rolepay is built on, as README.md states them. Many
 * access keys per account is folded into access keys (a budget for the bot and one per policy).
 */
const POINTS = [
  { Icon: KeyIcon, title: 'Access keys, many per account', body: 'A budget for the bot and one per policy, enforced by the protocol even inside a batch.' },
  { Icon: FingerprintIcon, title: 'Passkey accounts', body: "The treasury's root key is a passkey. Recipients need no wallet and no seed phrase." },
  { Icon: MemoIcon, title: "Memo'd stablecoin transfers", body: 'Every payout line carries its run and line number.' },
  { Icon: NoGasIcon, title: 'Fee sponsorship', body: 'Recipients never need gas to be paid.' },
  { Icon: DepositIcon, title: 'Virtual addresses (TIP-1022)', body: 'A deposit address per funder, credited to the treasury in the same transaction. No sweep.' },
  { Icon: SwapIcon, title: 'Enshrined stablecoin DEX', body: 'Each person paid in the stablecoin they choose, swapped inside the same batch.' },
] as const

const CELL_W = 760
const COL_X = [160, 1000] as const
const ROW_Y = [234, 474, 714] as const
const RING = 72

export const WhyTempo: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <Scene kicker="Why Tempo">
      {POINTS.map(({ Icon, title, body }, i) => {
        const at = 10 + i * 12
        const x = COL_X[i % 2] ?? 0
        const y = ROW_Y[Math.floor(i / 2)] ?? 0
        return (
          <div key={title} style={{ position: 'absolute', left: x, top: y, width: CELL_W, display: 'flex', gap: 30, paddingTop: 28, borderTop: `1px solid ${white(0.1)}`, ...enter(frame, at, { distance: 12 }) }}>
            <div style={{ width: RING, height: RING, flex: 'none', borderRadius: RING / 2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: gold(0.06), boxShadow: `inset 0 0 0 1.5px ${gold(0.45)}` }}>
              <Icon size={34} color={C.gold} strokeWidth={1.45} draw={progress(frame, at + 2, 24, EASE_IN_OUT)} />
            </div>
            <div style={{ paddingTop: 2 }}>
              <div style={{ font: `400 40px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em', whiteSpace: 'nowrap' }}>{title}</div>
              <div style={{ marginTop: 12, font: `400 24px/1.45 ${SANS}`, color: C.soft, maxWidth: 630 }}>{body}</div>
            </div>
          </div>
        )
      })}
    </Scene>
  )
}
