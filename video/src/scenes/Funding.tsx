import { getLength, getPointAtLength } from '@remotion/paths'
import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { CheckIcon, CoinsIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { TREASURY_BLOCK_H, TreasuryBlock } from '../components/Treasury'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, mix, progress } from '../motion'
import { C, gold, panel, sec, white } from '../theme'

export const FUNDING_FRAMES = sec(10)

/*
 * Funding with attribution, on Tempo's virtual addresses (TIP-1022). Each funding source has its
 * own deposit address, derived off chain from the treasury's masterId and the source's tag; what
 * is sent there is credited to the treasury inside the same transaction, the address holds
 * nothing, and Rolepay records the deposit under its source. The sources and amounts are the ones
 * packages/core/test/funding.chain.test.ts sent on Moderato (linked in the README): "Q4 bounty
 * sponsor: Acme DAO" (tag 1) received 1.25 AlphaUSD and "Judges pool" (tag 2) 2.5 AlphaUSD, so
 * the month reads 3.75 AlphaUSD from 2 sources. The address shows the TIP-1022 layout with the
 * treasury's 4-byte masterId elided as dots: [masterId][fdfd...fdfd][6-byte tag].
 */

// Timing, in frames.
const T = {
  sponsors: [6, 14] as const,
  treasury: 20,
  chips: [26, 34] as const,
  guides: 46,
  list: 70,
  deposits: [96, 124] as const,
  caption: 206,
  sub: 222,
}
const TRAVEL = 44
const ARRIVE = [T.deposits[0] + TRAVEL, T.deposits[1] + TRAVEL] as const

// Geometry.
const ROW_Y = [300, 480] as const
const MID_Y = (ROW_Y[0] + ROW_Y[1]) / 2
const SPONSOR_X = 160
const AVATAR = 64
const FROM_X = 444
const CHIP_X = 620
const CHIP_W = 440
const TREASURY_X = 1300
const TREASURY_TOP = MID_Y - TREASURY_BLOCK_H / 2
const TILE_Y = TREASURY_TOP + 52 // the vault tile's centre
const INTO_X = TREASURY_X - 16
const LIST = { x: 620, w: 1080, top: 594 }

const SOURCES = [
  { short: 'Acme DAO', sub: 'Q4 bounty sponsor', name: 'Q4 bounty sponsor: Acme DAO', tag: '000000000001', amount: '1.25 AlphaUSD' },
  { short: 'Judges pool', sub: 'Funding source', name: 'Judges pool', tag: '000000000002', amount: '2.5 AlphaUSD' },
] as const

const flowPath = (y: number) => {
  const d = `M${FROM_X} ${y} L${CHIP_X + CHIP_W + 16} ${y} C${CHIP_X + CHIP_W + 120} ${y} ${INTO_X - 100} ${TILE_Y} ${INTO_X} ${TILE_Y}`
  return { d, length: getLength(d) }
}
const FLOWS = ROW_Y.map(flowPath)

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const smallLabel: React.CSSProperties = { font: `600 14px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.meta, whiteSpace: 'nowrap' }

export const Funding: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <Scene kicker="Funding with attribution">
      <AbsoluteFill>
        <Guides frame={frame} />
        {SOURCES.map((s, i) => (
          <Source key={s.tag} i={i} frame={frame} />
        ))}
        <TreasuryBlock frame={frame} at={T.treasury} left={TREASURY_X} top={TREASURY_TOP} sub="Credited in the same transaction" />
        <Arrivals frame={frame} />
        <Dots frame={frame} />
        <List frame={frame} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 846, textAlign: 'center' }}>
        <div style={{ ...enter(frame, T.caption, { duration: 24, distance: 14 }), font: `400 52px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
          Money in, attributed. <span style={{ color: C.gold }}>No sweeps.</span>
        </div>
        <div style={{ ...enter(frame, T.sub, { duration: 20, distance: 10 }), marginTop: 22, font: `400 23px/1.3 ${SANS}`, color: C.soft }}>
          A deposit address is a Tempo virtual address (TIP-1022): it holds nothing and can only add money.
        </div>
      </div>
    </Scene>
  )
}

const Guides: React.FC<{ frame: number }> = ({ frame }) => (
  <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
    {FLOWS.map((f, i) => {
      const t = progress(frame, T.guides + i * 5, 22, EASE_IN_OUT)
      const trail = progress(frame, T.deposits[i] ?? 0, TRAVEL, EASE_IN_OUT)
      return (
        <g key={i}>
          <path d={f.d} pathLength={1} fill="none" stroke={white(0.08)} strokeWidth={1.5} strokeDasharray="1 1" strokeDashoffset={1 - t} />
          <path d={f.d} fill="none" stroke={gold(0.45)} strokeWidth={2} strokeDasharray={`${f.length} ${f.length}`} strokeDashoffset={f.length * (1 - trail)} opacity={trail > 0 ? 1 : 0} />
        </g>
      )
    })}
  </svg>
)

/** A funder, and the deposit address that is theirs alone. */
const Source: React.FC<{ i: number; frame: number }> = ({ i, frame }) => {
  const s = SOURCES[i]
  const y = ROW_Y[i] ?? 0
  if (!s) return null
  // The address lights as the deposit passes through it, and keeps nothing.
  const start = T.deposits[i] ?? 0
  const pass = progress(frame, start + TRAVEL * 0.25, 6) * (1 - progress(frame, start + TRAVEL * 0.62, 10))
  return (
    <>
      <div style={{ position: 'absolute', left: SPONSOR_X, top: y - AVATAR / 2, display: 'flex', alignItems: 'center', gap: 22, ...enter(frame, T.sponsors[i] ?? 0, { distance: 10 }) }}>
        <div style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: white(0.03), boxShadow: `inset 0 0 0 1.5px ${white(0.14)}` }}>
          <CoinsIcon size={30} color={C.soft} strokeWidth={1.5} />
        </div>
        <div style={{ whiteSpace: 'nowrap' }}>
          <div style={{ font: `400 25px/1.15 ${SANS}`, color: C.fg }}>{s.short}</div>
          <div style={{ marginTop: 6, font: `400 19px/1.2 ${SANS}`, color: C.meta }}>{s.sub}</div>
        </div>
      </div>

      <div style={{ position: 'absolute', left: CHIP_X, top: y - 56, ...smallLabel, ...enter(frame, (T.chips[i] ?? 0) + 6, { duration: 14, distance: 6 }) }}>Its own deposit address</div>
      <div
        style={{
          position: 'absolute',
          left: CHIP_X,
          top: y - 28,
          width: CHIP_W,
          height: 56,
          borderRadius: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: gold(0.03 + 0.08 * pass),
          boxShadow: `inset 0 0 0 1px ${pass > 0 ? gold(0.25 + 0.4 * pass) : white(0.14)}`,
          font: `400 19px/1 ${MONO}`,
          whiteSpace: 'nowrap',
          ...enter(frame, T.chips[i] ?? 0, { distance: 8 }),
        }}
      >
        <span style={{ color: C.soft }}>0x</span>
        <span style={{ color: C.muted, letterSpacing: '0.04em' }}>········</span>
        <span style={{ color: C.soft }}>fdfd…fdfd</span>
        <span style={{ color: C.gold }}>{s.tag}</span>
      </div>
      <div style={{ position: 'absolute', left: CHIP_X, top: y + 40, font: `400 17px/1.2 ${SANS}`, color: C.meta, whiteSpace: 'nowrap', ...enter(frame, (T.chips[i] ?? 0) + 14, { duration: 14, distance: 6 }) }}>
        Holds nothing: it forwards in the same transaction
      </div>
    </>
  )
}

/** The deposits, one behind the other, straight through each address into the treasury. */
const Dots: React.FC<{ frame: number }> = ({ frame }) => (
  <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
    {FLOWS.map((f, i) => {
      const t = progress(frame, T.deposits[i] ?? 0, TRAVEL, EASE_IN_OUT)
      if (t <= 0 || t >= 1) return null
      const p = getPointAtLength(f.d, f.length * t)
      return p ? <circle key={i} cx={p.x} cy={p.y} r={7} fill={C.gold} /> : null
    })}
  </svg>
)

/** What the treasury received, beside it, as each deposit lands. */
const Arrivals: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ position: 'absolute', left: TREASURY_X + 104 + 28, top: TILE_Y - 40 }}>
    {SOURCES.map((s, i) => {
      const p = progress(frame, (ARRIVE[i] ?? 0) - 2, 12)
      return (
        <div key={s.tag} style={{ height: 40, font: `400 26px/40px ${SERIF}`, color: C.gold, whiteSpace: 'nowrap', opacity: p, transform: `translateY(${mix(p, 6, 0)}px)` }}>
          +{s.amount}
        </div>
      )
    })}
  </div>
)

/** The dashboard's Funding page, in short: this month's total, then each deposit under its source. */
const List: React.FC<{ frame: number }> = ({ frame }) => {
  // The month's total counts up as each deposit is recorded: 1.25, then 3.75 (the chain test's sum).
  const amount = 1.25 * progress(frame, ARRIVE[0], 14, EASE_IN_OUT) + 2.5 * progress(frame, ARRIVE[1], 14, EASE_IN_OUT)
  const sources = ARRIVE.filter((a) => frame >= a).length
  return (
    <div style={{ position: 'absolute', left: LIST.x, top: LIST.top, width: LIST.w, ...panel, borderRadius: 20, padding: '22px 28px 12px', boxSizing: 'border-box', ...enter(frame, T.list, { duration: 18, distance: 10 }) }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 14, borderBottom: `1px solid ${white(0.08)}` }}>
        <span style={{ font: `400 30px/1 ${SERIF}`, color: C.head }}>Funding</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 16, whiteSpace: 'nowrap' }}>
          <span style={smallLabel}>Funded this month</span>
          <span style={{ font: `400 30px/1 ${SERIF}`, color: C.gold, fontVariantNumeric: 'tabular-nums lining-nums', minWidth: 186, textAlign: 'right' }}>
            {amount.toFixed(2).replace(/\.?0+$/, '')} AlphaUSD
          </span>
          <span style={{ font: `400 18px/1 ${SANS}`, color: C.meta, minWidth: 128 }}>from {sources} {sources === 1 ? 'source' : 'sources'}</span>
        </span>
      </div>
      {SOURCES.map((s, i) => {
        const p = progress(frame, (ARRIVE[i] ?? 0) + 4, 16)
        return (
          <div key={s.tag} style={{ display: 'flex', alignItems: 'center', height: 52, borderTop: i === 0 ? 'none' : `1px solid ${white(0.06)}`, opacity: 0.35 + 0.65 * p }}>
            <span style={{ flex: 1, font: `400 22px/1 ${SANS}`, color: C.fg, whiteSpace: 'nowrap' }}>{s.name}</span>
            <span style={{ width: 220, textAlign: 'right', font: `400 26px/1 ${SERIF}`, color: p > 0 ? C.head : C.meta, whiteSpace: 'nowrap' }}>{p > 0 ? s.amount : '·'}</span>
            <span style={{ width: 210, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, font: `400 18px/1 ${SANS}`, color: C.meta, opacity: p }}>
              <CheckIcon size={20} color={C.gold} strokeWidth={2} draw={p} />
              attributed
            </span>
          </div>
        )
      })}
    </div>
  )
}
