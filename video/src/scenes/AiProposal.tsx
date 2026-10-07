import React from 'react'
import { useCurrentFrame } from 'remotion'
import { Mark } from '../components/Mark'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { enter, progress } from '../motion'
import { C, gold, panel, sec, white } from '../theme'

export const AI_PROPOSAL_FRAMES = sec(8)

/*
 * 5. AI proposes, a human approves. The proposal as Discord shows it to the proposer (an
 * ephemeral message), assembled line by line. Its wording follows the real embed in
 * packages/discord/src/views/proposal.ts: "Pay run proposal", From, Instruction, numbered lines with
 * the reason and a source link, Total and Bot key, "Left out (shown, not in the run)" with the
 * hold reason, and the footer "Drafted by Sonnet 5.5 · 2.1 s · $0.004". The people are made up.
 */

const DISCORD_TEXT = '#DBDEE1'
const body: React.CSSProperties = { font: `400 21px/1.4 ${SANS}`, color: DISCORD_TEXT }

const Mention: React.FC<{ name: string }> = ({ name }) => (
  <span style={{ padding: '1px 6px', borderRadius: 5, background: white(0.09), color: C.head, fontWeight: 500 }}>@{name}</span>
)
const Link: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: C.soft, textDecoration: 'underline', textDecorationColor: gold(0.45), textUnderlineOffset: 5 }}>{children}</span>
)
const Dot: React.FC = () => <span style={{ color: C.meta }}> · </span>

const LINES = [
  { name: 'mira', amount: '50', why: 'won the indexer bounty' },
  { name: 'jonas', amount: '20', why: 'docs bounty' },
  { name: 'sol', amount: '20', why: 'bug bash winner' },
] as const

const FieldName: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ font: `600 20px/1.3 ${SANS}`, color: C.head }}>{children}</div>
)

const Button: React.FC<{ children: React.ReactNode; primary?: boolean }> = ({ children, primary }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      height: 46,
      padding: '0 22px',
      borderRadius: 9,
      font: `500 20px/1 ${SANS}`,
      color: primary ? C.gold : C.fg,
      background: primary ? gold(0.14) : white(0.07),
      boxShadow: primary ? `inset 0 0 0 1px ${gold(0.4)}` : 'none',
    }}
  >
    {children}
  </span>
)

export const AiProposal: React.FC = () => {
  const frame = useCurrentFrame()
  const at = (start: number) => enter(frame, start, { duration: 14, distance: 8 })
  const bar = progress(frame, 14, 22)
  return (
    <Scene kicker="AI proposes, a human approves">
      <div style={{ position: 'absolute', left: 160, top: 0, bottom: 0, display: 'flex', alignItems: 'center' }}>
        <div style={{ ...panel, ...enter(frame, 4, { duration: 18, distance: 12 }), width: 1030, padding: '26px 34px 24px', marginTop: 40 }}>
          {/* The message header: the bot, the app tag, the time. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, ...at(8) }}>
            <div style={{ width: 44, height: 44, borderRadius: 22, overflow: 'hidden' }}>
              <Mark size={44} />
            </div>
            <span style={{ font: `600 23px/1 ${SANS}`, color: C.head }}>Rolepay</span>
            <span style={{ padding: '4px 7px', borderRadius: 5, background: white(0.1), font: `600 13px/1 ${SANS}`, letterSpacing: '0.04em', color: C.fg }}>APP</span>
            <span style={{ font: `400 18px/1 ${SANS}`, color: C.meta }}>Today at 18:02</span>
          </div>

          <div style={{ marginLeft: 60, marginTop: 10 }}>
            {/* The embed. */}
            <div style={{ position: 'relative', borderRadius: 8, background: white(0.035), padding: '20px 28px 20px 32px', ...at(12) }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, borderRadius: '8px 0 0 8px', background: C.gold, transform: `scaleY(${bar})`, transformOrigin: 'top' }} />
              <div style={{ font: `600 24px/1.3 ${SANS}`, color: C.head, ...at(18) }}>Pay run proposal</div>
              <div style={{ ...body, marginTop: 8, ...at(26) }}>
                <b style={{ color: C.head }}>From:</b> <Link>1 message</Link> in <span style={{ color: C.head }}>#bounties</span>.
              </div>
              <div style={{ ...body, ...at(32) }}>
                <b style={{ color: C.head }}>Instruction:</b> 20 each, the indexer one 50
              </div>

              <div style={{ marginTop: 12 }}>
                {LINES.map((l, i) => (
                  <div key={l.name} style={{ ...body, lineHeight: 1.55, ...at(44 + i * 8) }}>
                    {i + 1}. <Mention name={l.name} />
                    {'  '}
                    <span style={{ color: C.head }}>{l.amount} AlphaUSD</span>
                    <Dot />
                    {l.why}
                    <Dot />
                    <Link>source</Link>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 90, marginTop: 14, ...at(74) }}>
                <div>
                  <FieldName>Total</FieldName>
                  <div style={body}>90 AlphaUSD for 3 people</div>
                </div>
                <div>
                  <FieldName>Bot key</FieldName>
                  <div style={body}>100 AlphaUSD left</div>
                </div>
              </div>

              <div style={{ marginTop: 14, ...at(90) }}>
                <FieldName>Left out (shown, not in the run)</FieldName>
                <div style={{ ...body, display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
                  <span
                    style={{
                      padding: '5px 10px 4px',
                      borderRadius: 999,
                      boxShadow: `inset 0 0 0 1px rgba(226,178,110,0.45)`,
                      font: `600 13px/1 ${SANS}`,
                      letterSpacing: '0.16em',
                      color: C.warn,
                    }}
                  >
                    HELD
                  </span>
                  <span>
                    <Mention name="kit" /> 10,000 AlphaUSD: <span style={{ color: C.head }}>their own message is the only source.</span>
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 16, font: `400 17px/1.5 ${SANS}`, color: C.meta, ...at(106) }}>
                Proposal p7kq2. A draft: nothing is paid until a member with the approver role approves the run.
              </div>
              <div style={{ font: `400 17px/1.5 ${SANS}`, color: C.soft, ...at(118) }}>
                Drafted by Sonnet 5.5 · 2.1 s · <span style={{ color: C.gold, fontWeight: 600 }}>$0.004</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 14, ...at(112) }}>
              <Button primary>Create pay run</Button>
              <Button>Edit</Button>
              <Button>Discard</Button>
            </div>
            <div style={{ marginTop: 12, font: `400 16px/1 ${SANS}`, color: C.meta, ...at(122) }}>Only you can see this · Dismiss message</div>
          </div>
        </div>
      </div>

      {/* The claim, on the right. */}
      <div style={{ position: 'absolute', left: 1290, width: 470, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ ...enter(frame, 134, { duration: 22, distance: 14 }), font: `400 60px/1.16 ${SERIF}`, color: C.head, letterSpacing: '-0.014em', marginTop: 40 }}>
          An AI proposal costs <span style={{ color: C.gold }}>less than half a cent.</span>
        </div>
        <div style={{ ...enter(frame, 148, { duration: 20, distance: 10 }), marginTop: 30, paddingTop: 24, borderTop: `1px solid ${white(0.1)}`, font: `400 23px/1.45 ${SANS}`, color: C.soft }}>
          Sonnet 5.5 with the prompt cache warm, measured live. A human still approves every run.
        </div>
      </div>
    </Scene>
  )
}
