import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { KeyIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { TREASURY_BLOCK_H, TreasuryBlock } from '../components/Treasury'
import { SANS, SERIF } from '../fonts'
import { EASE_IN, EASE_IN_OUT, EASE_OUT, enter, mix, progress } from '../motion'
import { C, gold, sec, white } from '../theme'

export const OWN_BUDGETS_FRAMES = sec(12)

/*
 * One access key per policy. One treasury, two keys its passkey authorised: the bot key and the
 * Judges policy's own key, each with its own limit (a bar with a hard gold line at its end, as the
 * dashboard draws a key's budget). The policy's batch runs into its own line and is refused whole,
 * while the bot key still has room and is never used for it. What the chain proved on Moderato with
 * Rolepay's checks skipped (packages/core/test/policyKey.chain.test.ts, linked in the README): a
 * batch over the policy key's remaining limit reverted whole with SpendingLimitExceeded while the
 * bot key had plenty left. The bars carry no amounts: the demo's Judges policy has whatever limit
 * the treasurer gives it, so the picture states only what holds for any limit.
 */

// Timing, in frames.
const T = {
  treasury: 6,
  links: 30,
  chips: [40, 54] as const,
  scope: [58, 70] as const,
  bars: 78,
  limits: 94,
  fills: [104, 112] as const,
  batch: 160,
  outcome: 198,
  room: 216,
  dim: 268,
  caption: 278,
  footnote: 296,
}
const REACH = 26 // the batch, from what is spent to the line
const HIT = T.batch + REACH

// Geometry, on the 1920 by 1080 frame.
const ROW_Y = [330, 590] as const // the bot key, then the policy's key
const MID_Y = (ROW_Y[0] + ROW_Y[1]) / 2
const TREASURY_X = 160
const TREASURY_TOP = MID_Y - TREASURY_BLOCK_H / 2
const FORK_X = 604
const KEY_X = 700
const CHIP_W = 460
const BAR_X = 1210
const LIMIT_X = 1660
const BAR_W = LIMIT_X - BAR_X
const BAR_H = 10
const SPENT = [0.22, 0.7] as const // how much of each key's budget is spent this period (no amounts)
const BATCH = 0.45 // the policy's batch, as a share of its budget: more than what is left
const OVER = SPENT[1] + BATCH - 1 // how far past the line it would go

const KEYS = [
  { name: 'Bot key', scope: 'Manual runs, AI proposals, other policies' },
  { name: 'Judges policy key', scope: "The Judges policy's runs, nothing else" },
] as const

const label: React.CSSProperties = { font: `600 14px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', whiteSpace: 'nowrap' }

export const OwnBudgets: React.FC = () => {
  const frame = useCurrentFrame()
  const dim = 1 - 0.55 * progress(frame, T.dim, 22)
  return (
    <Scene kicker="Its own on-chain budget">
      <AbsoluteFill style={{ opacity: dim }}>
        <TreasuryBlock frame={frame} at={T.treasury} left={TREASURY_X} top={TREASURY_TOP} sub="Its passkey authorises both" />
        <Links frame={frame} />
        {KEYS.map((k, i) => (
          <KeyRow key={k.name} i={i} frame={frame} />
        ))}
        <Outcomes frame={frame} />
      </AbsoluteFill>
      <Closing frame={frame} />
    </Scene>
  )
}

/** The passkey authorises both keys: two hairlines from the treasury, one to each key. */
const Links: React.FC<{ frame: number }> = ({ frame }) => (
  <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
    {ROW_Y.map((y, i) => {
      const t = progress(frame, T.links + i * 6, 22, EASE_IN_OUT)
      const end = KEY_X - 16
      return (
        <g key={y}>
          <path
            d={`M${FORK_X} ${MID_Y} C${FORK_X + 48} ${MID_Y} ${FORK_X + 40} ${y} ${end} ${y}`}
            pathLength={1}
            fill="none"
            stroke={gold(0.5)}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray="1 1"
            strokeDashoffset={1 - t}
            opacity={t > 0 ? 1 : 0}
          />
          <path d={`M${end - 9} ${y - 7} L${end} ${y} L${end - 9} ${y + 7}`} fill="none" stroke={gold(0.7)} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={progress(frame, T.links + i * 6 + 18, 8)} />
        </g>
      )
    })}
  </svg>
)

const KeyRow: React.FC<{ i: number; frame: number }> = ({ i, frame }) => {
  const y = ROW_Y[i] ?? 0
  const key = KEYS[i]
  const chip = progress(frame, T.chips[i] ?? 0, 24)
  const track = progress(frame, T.bars + i * 6, 22, EASE_IN_OUT)
  const line = progress(frame, T.limits + i * 6, 16, EASE_OUT)
  const spent = (SPENT[i] ?? 0) * progress(frame, T.fills[i] ?? 0, 26, EASE_IN_OUT)
  // The line flares when the policy's batch runs into it, then stays hard.
  const hit = i === 1 ? progress(frame, HIT, 6, EASE_OUT) * (1 - 0.6 * progress(frame, HIT + 6, 26, EASE_OUT)) : 0
  const hard = i === 1 ? progress(frame, HIT, 8) : 0
  return (
    <>
      {/* The key, as the trust model draws the bot's access key. */}
      <div
        style={{
          position: 'absolute',
          left: KEY_X,
          top: y - 36,
          width: CHIP_W,
          height: 72,
          borderRadius: 18,
          background: gold(0.075),
          boxShadow: `inset 0 0 0 1.5px ${gold(0.42)}, inset 0 1px 0 ${gold(0.25)}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          gap: 16,
          opacity: chip,
          transform: `translateX(${mix(chip, -60, 0)}px)`,
        }}
      >
        <KeyIcon size={34} color={C.gold} strokeWidth={1.5} />
        <span style={{ font: `500 25px/1 ${SANS}`, color: C.head, whiteSpace: 'nowrap' }}>{key?.name}</span>
      </div>
      <div style={{ position: 'absolute', left: KEY_X + 4, top: y + 52, font: `400 20px/1.3 ${SANS}`, color: C.meta, whiteSpace: 'nowrap', ...enter(frame, T.scope[i] ?? 0, { duration: 16, distance: 8 }) }}>
        {key?.scope}
      </div>

      {/* Its budget this period: spent so far, then the hard line at its limit. */}
      <div style={{ position: 'absolute', left: BAR_X, top: y - BAR_H / 2, width: BAR_W * track, height: BAR_H, borderRadius: BAR_H / 2, background: white(0.08), overflow: 'hidden' }}>
        <div style={{ height: BAR_H, width: BAR_W * spent, borderRadius: BAR_H / 2, background: gold(0.72) }} />
      </div>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <defs>
          <filter id={`limit-flare-${i}`} x="-400%" y="-40%" width="900%" height="180%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>
        <line x1={LIMIT_X} y1={mix(line, y, y - 32)} x2={LIMIT_X} y2={mix(line, y, y + 32)} stroke={gold(0.6 + 0.35 * hard)} strokeWidth={2.5 + 1.5 * hard} strokeLinecap="round" opacity={line > 0 ? 1 : 0} />
        <line x1={LIMIT_X} y1={y - 26} x2={LIMIT_X} y2={y + 26} stroke={gold(0.9)} strokeWidth={9} filter={`url(#limit-flare-${i})`} opacity={hit} />
      </svg>
      <div style={{ position: 'absolute', left: LIMIT_X - 150, width: 300, top: y - 62, textAlign: 'center', ...label, color: C.gold, opacity: progress(frame, T.limits + i * 6 + 8, 14) }}>
        On-chain limit
      </div>

      {i === 1 ? <Batch frame={frame} y={y} /> : null}
    </>
  )
}

/** The policy's batch: it grows from what is spent, runs into the line, and is refused whole. */
const Batch: React.FC<{ frame: number; y: number }> = ({ frame, y }) => {
  if (frame < T.batch) return null
  const from = BAR_X + BAR_W * (SPENT[1] ?? 0)
  const reach = progress(frame, T.batch, REACH, EASE_IN_OUT)
  const head = mix(reach, from, LIMIT_X - 3)
  const grey = progress(frame, HIT + 4, 12)
  const gone = progress(frame, HIT + 20, 20, EASE_IN)
  const ghost = progress(frame, HIT, 10) * (1 - gone)
  const color = grey > 0.5 ? C.meta : C.gold
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: from,
          top: y - BAR_H / 2,
          width: Math.max(0, head - from),
          height: BAR_H,
          borderRadius: BAR_H / 2,
          background: color,
          boxShadow: grey > 0.5 ? 'none' : `0 0 18px ${gold(0.45)}`,
          opacity: (1 - 0.45 * grey) * (1 - gone),
        }}
      />
      {/* The part that does not fit, past the line. */}
      <div
        style={{
          position: 'absolute',
          left: LIMIT_X + 6,
          top: y - BAR_H / 2 - 1,
          width: BAR_W * OVER,
          height: BAR_H + 2,
          borderRadius: BAR_H / 2 + 1,
          border: `1.5px dashed ${white(0.32)}`,
          boxSizing: 'border-box',
          opacity: ghost,
        }}
      />
    </>
  )
}

/** What happened: refused whole on the policy's key; room left on the bot key, untouched. */
const Outcomes: React.FC<{ frame: number }> = ({ frame }) => {
  const head: React.CSSProperties = { font: `400 25px/1.2 ${SERIF}`, color: C.head, whiteSpace: 'nowrap' }
  const small: React.CSSProperties = { marginTop: 8, font: `400 18px/1.3 ${SANS}`, color: C.meta, whiteSpace: 'nowrap' }
  return (
    <>
      <div style={{ position: 'absolute', left: BAR_X, top: (ROW_Y[1] ?? 0) + 30, ...enter(frame, T.outcome, { duration: 18, distance: 8 }) }}>
        <div style={head}>Refused whole by the chain</div>
        <div style={{ ...small, font: '400 18px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace' }}>SpendingLimitExceeded</div>
      </div>
      <div style={{ position: 'absolute', left: BAR_X, top: (ROW_Y[0] ?? 0) + 30, ...enter(frame, T.room, { duration: 18, distance: 8 }) }}>
        <div style={{ ...head, color: C.gold }}>Room left</div>
        <div style={small}>Never used for the Judges policy</div>
      </div>
    </>
  )
}

const Closing: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 846, textAlign: 'center' }}>
    <div style={{ ...enter(frame, T.caption, { duration: 24, distance: 14 }), font: `400 52px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
      Every agent gets its own budget. <span style={{ color: C.gold }}>The chain enforces each one.</span>
    </div>
    <div style={{ ...enter(frame, T.footnote, { duration: 20, distance: 10 }), marginTop: 22, font: `400 23px/1.3 ${SANS}`, color: C.soft }}>
      On Moderato, with Rolepay's checks skipped: the policy key's batch reverted whole while the bot key had plenty left.
    </div>
  </div>
)
