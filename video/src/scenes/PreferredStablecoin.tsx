import { getLength, getPointAtLength } from '@remotion/paths'
import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { PersonIcon, SwapIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { TREASURY_BLOCK_H, TreasuryBlock } from '../components/Treasury'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, EASE_OUT, enter, mix, progress } from '../motion'
import { C, gold, sec, white } from '../theme'

export const PREFERRED_STABLECOIN_FRAMES = sec(10)

/*
 * Each person paid in the stablecoin they choose, in one batch. The run from
 * packages/core/test/preferredToken.chain.test.ts on Moderato (linked in the README): the treasury
 * pays in AlphaUSD; Ana chose BetaUSD, Bo did not. One transaction: first the exact-output swap on
 * Tempo's stablecoin DEX (1.5 BetaUSD for at most 1.515 AlphaUSD, the 1% cap), then one
 * transferWithMemo per line, each in its own token with its own memo: 1.5 BetaUSD to Ana (line 1),
 * 1 AlphaUSD to Bo (line 2). A filled dot is AlphaUSD, a ring is BetaUSD.
 */

// Timing, in frames.
const T = {
  treasury: 6,
  lanes: 30,
  dex: 40,
  people: [50, 58] as const,
  calls: 70,
  flow: 108,
  dim: 190,
  caption: 196,
  sub: 212,
}
const TO_DEX = 22 // Ana's AlphaUSD, from the treasury into the exchange
const SWAP = 14 // inside the exchange
const TO_ANA = 22 // her BetaUSD, out to her
const BO_TRAVEL = 64
const AT_DEX = T.flow + TO_DEX
const OUT_OF_DEX = AT_DEX + SWAP
const ANA_PAID = OUT_OF_DEX + TO_ANA
const BO_PAID = T.flow + BO_TRAVEL

// Geometry.
const ANA_Y = 340
const BO_Y = 580
const MID_Y = (ANA_Y + BO_Y) / 2
const START_X = 604
const LANE_X = 740
const DEX_X = 1000
const DEX_R = 46
const PEOPLE_X = 1384
const AVATAR = 64
const END_X = PEOPLE_X - 8

const fan = (y: number) => `M${START_X} ${MID_Y} C${START_X + 56} ${MID_Y} ${START_X + 56} ${y} ${LANE_X} ${y}`
const path = (d: string) => ({ d, length: getLength(d) })
const ANA_IN = path(`${fan(ANA_Y)} L${DEX_X - DEX_R} ${ANA_Y}`)
const ANA_OUT = path(`M${DEX_X + DEX_R} ${ANA_Y} L${END_X} ${ANA_Y}`)
const BO = path(`${fan(BO_Y)} L${END_X} ${BO_Y}`)

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const smallLabel: React.CSSProperties = { font: `600 14px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.meta, whiteSpace: 'nowrap' }

export const PreferredStablecoin: React.FC = () => {
  const frame = useCurrentFrame()
  const dim = 1 - 0.35 * progress(frame, T.dim, 20)
  return (
    <Scene kicker="The stablecoin they choose">
      <AbsoluteFill style={{ opacity: dim }}>
        <TreasuryBlock frame={frame} at={T.treasury} left={160} top={MID_Y - TREASURY_BLOCK_H / 2} sub="Pays in AlphaUSD" />
        <Flows frame={frame} />
        <Exchange frame={frame} />
        <Person frame={frame} y={ANA_Y} at={T.people[0]} name="Ana" choice="chose BetaUSD" paid="+1.5 BetaUSD" paidAt={ANA_PAID} />
        <Person frame={frame} y={BO_Y} at={T.people[1]} name="Bo" choice="takes AlphaUSD" paid="+1 AlphaUSD" paidAt={BO_PAID} />
        <Calls frame={frame} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 846, textAlign: 'center' }}>
        <div style={{ ...enter(frame, T.caption, { duration: 24, distance: 14 }), font: `400 52px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
          Paid in the stablecoin they choose, <span style={{ color: C.gold }}>in one batch.</span>
        </div>
        <div style={{ ...enter(frame, T.sub, { duration: 20, distance: 10 }), marginTop: 22, font: `400 23px/1.3 ${SANS}`, color: C.soft }}>
          A swap past its cap reverts the whole batch with <span style={{ font: `400 21px/1 ${MONO}` }}>MaxInputExceeded</span>. Nobody is paid.
        </div>
      </div>
    </Scene>
  )
}

/** A token's mark: AlphaUSD is a filled dot, BetaUSD a ring. */
const TokenDot: React.FC<{ cx: number; cy: number; ring?: boolean; opacity?: number }> = ({ cx, cy, ring, opacity = 1 }) =>
  ring ? <circle cx={cx} cy={cy} r={7} fill={C.ink} stroke={C.gold} strokeWidth={2.5} opacity={opacity} /> : <circle cx={cx} cy={cy} r={7} fill={C.gold} opacity={opacity} />

const Flows: React.FC<{ frame: number }> = ({ frame }) => {
  const guide = (i: number) => progress(frame, T.lanes + i * 5, 22, EASE_IN_OUT)
  const legs = [
    { p: ANA_IN, t: progress(frame, T.flow, TO_DEX, EASE_IN_OUT), ring: false },
    { p: ANA_OUT, t: progress(frame, OUT_OF_DEX, TO_ANA, EASE_IN_OUT), ring: true },
    { p: BO, t: progress(frame, T.flow, BO_TRAVEL, EASE_IN_OUT), ring: false },
  ]
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        {/* Faint guides, then a gold trail behind each payment. */}
        {[ANA_IN, ANA_OUT, BO].map((p, i) => (
          <path key={`g${i}`} d={p.d} pathLength={1} fill="none" stroke={white(0.08)} strokeWidth={1.5} strokeDasharray="1 1" strokeDashoffset={1 - guide(i === 2 ? 1 : 0)} />
        ))}
        {legs.map(({ p, t }, i) => (
          <path key={`t${i}`} d={p.d} fill="none" stroke={gold(0.45)} strokeWidth={2} strokeDasharray={`${p.length} ${p.length}`} strokeDashoffset={p.length * (1 - t)} opacity={t > 0 ? 1 : 0} />
        ))}
        {legs.map(({ p, t, ring }, i) => {
          if (t <= 0 || t >= 1) return null
          const pt = getPointAtLength(p.d, p.length * t)
          return pt ? <TokenDot key={`d${i}`} cx={pt.x} cy={pt.y} ring={ring} /> : null
        })}
      </svg>
      {/* Which token travels on each stretch, shown as its dot passes. */}
      <TokenLabel x={(LANE_X + DEX_X - DEX_R) / 2} y={ANA_Y} text="AlphaUSD" at={T.flow + TO_DEX * 0.45} frame={frame} />
      <TokenLabel x={(DEX_X + DEX_R + END_X) / 2} y={ANA_Y} text="BetaUSD" ring at={OUT_OF_DEX + TO_ANA * 0.45} frame={frame} />
      <TokenLabel x={(LANE_X + END_X) / 2} y={BO_Y} text="AlphaUSD" at={T.flow + BO_TRAVEL * 0.45} frame={frame} />
    </>
  )
}

const TokenLabel: React.FC<{ x: number; y: number; text: string; ring?: boolean; at: number; frame: number }> = ({ x, y, text, ring, at, frame }) => (
  <div style={{ position: 'absolute', left: x - 110, width: 220, top: y - 42, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, ...enter(frame, at, { duration: 14, distance: 6 }) }}>
    <svg width={16} height={16} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <TokenDot cx={8} cy={8} ring={ring} />
    </svg>
    <span style={{ font: `500 19px/1 ${SANS}`, color: C.soft }}>{text}</span>
  </div>
)

/** Tempo's stablecoin DEX, on Ana's line only: it pulses as her AlphaUSD becomes BetaUSD. */
const Exchange: React.FC<{ frame: number }> = ({ frame }) => {
  const swap = progress(frame, AT_DEX, 6, EASE_OUT) * (1 - progress(frame, OUT_OF_DEX, 14))
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: DEX_X - DEX_R,
          top: ANA_Y - DEX_R,
          width: DEX_R * 2,
          height: DEX_R * 2,
          borderRadius: DEX_R,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: gold(0.06 + 0.1 * swap),
          boxShadow: `inset 0 0 0 1.5px ${gold(0.5 + 0.4 * swap)}, 0 0 ${28 * swap}px ${gold(0.35 * swap)}`,
          ...enter(frame, T.dex, { distance: 10 }),
        }}
      >
        <SwapIcon size={38} color={C.gold} strokeWidth={1.5} draw={progress(frame, T.dex + 2, 22, EASE_IN_OUT)} />
      </div>
      <div style={{ position: 'absolute', left: DEX_X - 300, width: 600, top: ANA_Y + DEX_R + 18, textAlign: 'center', ...enter(frame, T.dex + 10, { duration: 16, distance: 8 }) }}>
        <div style={smallLabel}>Tempo's stablecoin DEX</div>
        <div style={{ marginTop: 12, font: `400 19px/1.3 ${SANS}`, color: C.soft, whiteSpace: 'nowrap' }}>Exact output: 1.5 BetaUSD for at most 1.515 AlphaUSD</div>
      </div>
    </>
  )
}

const Person: React.FC<{ frame: number; y: number; at: number; name: string; choice: string; paid: string; paidAt: number }> = ({ frame, y, at, name, choice, paid, paidAt }) => {
  const p = progress(frame, paidAt - 2, 12)
  return (
    <div style={{ position: 'absolute', left: PEOPLE_X, top: y - AVATAR / 2, display: 'flex', alignItems: 'center', gap: 22, ...enter(frame, at, { distance: 10 }) }}>
      <div
        style={{
          width: AVATAR,
          height: AVATAR,
          borderRadius: AVATAR / 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: white(0.03),
          boxShadow: `inset 0 0 0 1.5px ${p > 0 ? gold(0.25 + 0.4 * p) : white(0.14)}`,
        }}
      >
        <PersonIcon size={32} color={C.soft} strokeWidth={1.5} />
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, whiteSpace: 'nowrap' }}>
          <span style={{ font: `400 25px/1.15 ${SANS}`, color: C.fg }}>{name}</span>
          <span style={{ font: `400 19px/1.15 ${SANS}`, color: C.meta }}>{choice}</span>
        </div>
        <div style={{ marginTop: 6, height: 28, font: `400 26px/1.1 ${SERIF}`, color: C.gold, whiteSpace: 'nowrap', opacity: p, transform: `translateY(${mix(p, 6, 0)}px)` }}>{paid}</div>
      </div>
    </div>
  )
}

const CALLS = [
  { n: 1, call: 'swapExactAmountOut', rest: 'AlphaUSD to BetaUSD', at: AT_DEX + 2 },
  { n: 2, call: 'transferWithMemo', rest: 'BetaUSD to Ana, line 1', at: ANA_PAID },
  { n: 3, call: 'transferWithMemo', rest: 'AlphaUSD to Bo, line 2', at: BO_PAID },
] as const

/** The one transaction, in the order the chain runs it; each call lights as it happens. */
const Calls: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 690, textAlign: 'center', ...enter(frame, T.calls, { duration: 18, distance: 8 }) }}>
    <div style={smallLabel}>One transaction, in order</div>
    <div style={{ marginTop: 18, display: 'flex', justifyContent: 'center', gap: 18 }}>
      {CALLS.map((c) => {
        const lit = progress(frame, c.at, 12)
        return (
          <div
            key={c.n}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 12,
              height: 46,
              padding: '0 20px 0 16px',
              borderRadius: 23,
              background: lit > 0 ? gold(0.04 + 0.06 * lit) : white(0.025),
              boxShadow: `inset 0 0 0 1px ${lit > 0 ? gold(0.2 + 0.35 * lit) : white(0.13)}`,
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ font: `600 16px/1 ${SANS}`, color: lit > 0.5 ? C.gold : C.meta, fontVariantNumeric: 'tabular-nums' }}>{c.n}</span>
            <span style={{ font: `400 18px/1 ${MONO}`, color: C.fg }}>{c.call}</span>
            <span style={{ font: `400 18px/1 ${SANS}`, color: C.meta }}>{c.rest}</span>
          </div>
        )
      })}
    </div>
  </div>
)
