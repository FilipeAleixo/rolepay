import React from 'react'
import { useCurrentFrame } from 'remotion'
import { Scene } from '../components/Scene'
import { AI_PROPOSAL_USD, CHAIN_PROOFS, CHAIN_SUITE, LINE_COVERAGE, TOTAL_TESTS } from '../data/numbers'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, progress } from '../motion'
import { C, gold, sec, white } from '../theme'

export const NUMBERS_FRAMES = sec(8)

const COUNT = 38 // frames a count-up takes

const STATS = [
  { at: 14, value: (t: number) => Math.round(TOTAL_TESTS * t).toLocaleString('en-US'), label: 'tests in the default suite', detail: 'No network, no secrets. CI runs them on every push.' },
  {
    at: 26,
    value: (t: number) => String(Math.round(CHAIN_PROOFS.length * t)),
    label: 'chain proofs on Tempo testnet',
    detail: `Each on the explorer, from ${CHAIN_SUITE.tests} chain tests in ${CHAIN_SUITE.files} files.`,
  },
  { at: 38, value: (t: number) => `$${(AI_PROPOSAL_USD * t).toFixed(3)}`, label: 'per AI proposal', detail: 'Sonnet 5.5, prompt cache warm' },
] as const

const LIST_AT = 62
const COVERAGE_AT = 84

const smallLabel: React.CSSProperties = { font: `500 17px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.meta }

/** 7. By the numbers: count-ups of what the repo itself shows, then the chain proofs by name. */
export const Numbers: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <Scene kicker="By the numbers">
      <div style={{ position: 'absolute', left: 180, right: 180, top: 236, display: 'flex', justifyContent: 'space-between' }}>
        {STATS.map((s) => {
          const t = progress(frame, s.at + 4, COUNT, EASE_IN_OUT)
          return (
            <div key={s.label} style={{ width: 480, paddingTop: 30, borderTop: `1px solid ${white(0.1)}`, ...enter(frame, s.at, { distance: 12 }) }}>
              <div style={{ font: `400 132px/1 ${SERIF}`, color: C.head, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums lining-nums' }}>{s.value(t)}</div>
              <div style={{ marginTop: 22, font: `500 27px/1.3 ${SANS}`, color: C.fg }}>{s.label}</div>
              <div style={{ marginTop: 10, font: `400 21px/1.4 ${SANS}`, color: C.meta }}>{s.detail}</div>
            </div>
          )
        })}
      </div>

      {/* The chain proofs, by name, as the README links them. */}
      <div style={{ position: 'absolute', left: 180, right: 180, top: 576, ...enter(frame, LIST_AT, { distance: 8 }) }}>
        <div style={smallLabel}>The {CHAIN_PROOFS.length} chain proofs</div>
        <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', columnGap: 18, rowGap: 4, font: `400 20px/1.45 ${SANS}`, color: C.soft }}>
          {CHAIN_PROOFS.map((p, i) => (
            <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 18, whiteSpace: 'nowrap' }}>
              {i > 0 ? <span style={{ width: 5, height: 5, borderRadius: 3, background: gold(0.6) }} /> : null}
              {p}
            </span>
          ))}
        </div>
      </div>

      <div style={{ position: 'absolute', left: 180, right: 180, top: 760 }}>
        <div style={{ ...enter(frame, COVERAGE_AT, { distance: 8 }), ...smallLabel }}>Line coverage, per package</div>
        <div style={{ marginTop: 30, display: 'flex', justifyContent: 'space-between' }}>
          {LINE_COVERAGE.map((c, i) => {
            const at = COVERAGE_AT + 8 + i * 8
            const t = progress(frame, at + 4, 32, EASE_IN_OUT)
            return (
              <div key={c.pkg} style={{ width: 345, ...enter(frame, at, { distance: 10 }) }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span style={{ font: `500 25px/1 ${SANS}`, color: C.fg }}>{c.pkg}</span>
                  <span style={{ font: `400 46px/1 ${SERIF}`, color: C.head, fontVariantNumeric: 'tabular-nums lining-nums' }}>
                    {(c.pct * t).toFixed(1)}
                    <span style={{ font: `400 24px/1 ${SANS}`, color: C.meta, marginLeft: 4 }}>%</span>
                  </span>
                </div>
                <div style={{ marginTop: 18, height: 4, borderRadius: 2, background: white(0.08) }}>
                  <div style={{ height: 4, borderRadius: 2, width: `${c.pct * t}%`, background: gold(0.8) }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Scene>
  )
}
