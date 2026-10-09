import React from 'react'
import { Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { KeyIcon } from '../components/Icons'
import { Mark } from '../components/Mark'
import { RichText } from '../components/RichText'
import { Scene } from '../components/Scene'
import { CLEAR_BY } from '../components/VoiceCard'
import { hasAsset } from '../components/Slot'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, mix, progress } from '../motion'
import { C, SAFE, gold, sec, white } from '../theme'

/** Silent, the slide holds this long; with a voice-over it is as long as the speech. */
export const OVERVIEW_FRAMES = sec(15)

/*
 * The pitch's opening: what Rolepay is, how paying people works today and with Rolepay, and the
 * proof, on one slide, in the home page's words (packages/web/src/views/landing.ts: the tagline
 * and the "Today / With Rolepay" contrast). The mark and the name draw in large, then settle into
 * the slide's header. Each part then arrives at its share of the scene's length, in the order the
 * voice-over says them (what it is, today, with Rolepay, the proof), so the slide keeps pace with
 * a longer or a shorter read, and reads on its own when silent. Each column of the contrast
 * arrives whole, top to bottom, the "Today" column first; it steps back as the answers arrive.
 */
const WHAT = 'Pay the people who run your Discord community, in stablecoins on Tempo.'
const WHAT_SUB = "Approved in Discord, paid from the community's own account."
const CONTRAST = [
  { was: 'Working out who did what by hand, from Discord into a spreadsheet', now: 'A role, a reaction or plain words: Rolepay *finds the people*' },
  { was: 'A multisig batch outside Discord, once enough signers are online', now: '*One approval* in Discord, one\u00a0transaction, a receipt for every person' },
  { was: 'Every recipient needs a wallet and gas', now: 'Recipients need *only a passkey*, or the wallet they already have' },
  { was: 'Regular pay needs someone online to sign it', now: 'Regular pay *runs on its own*, within its budget, with time to veto' },
] as const
const PROOF = ['Live on Tempo mainnet', "The chain refuses any batch over the bot's budget"] as const

/** The title beat, in frames from the start, the same whatever the scene's length. */
const T = { tile: 0, outline: 3, fill: 17, face: 21, word: 8, settle: 36, header: 50, what: 46 }
const SETTLE = 22

/** Where each later part arrives, as a share of the speech (the voice-over's order). */
const SHARE = { today: 0.35, now: 0.66, proof: 0.88 } as const

/** Frames between two lines of one column as it arrives, top to bottom. */
const CASCADE = 12

/** Portrait for the name card, if one of these is in video/assets/. */
const PORTRAITS = ['pitch-1-portrait.jpg', 'pitch-1-portrait.jpeg', 'pitch-1-portrait.png'] as const

const label: React.CSSProperties = { font: `500 17px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase' }

export const Overview: React.FC = () => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const lead = sec(0.4)
  const span = Math.max(1, durationInFrames - lead - sec(1.4))
  const at = (share: number) => Math.max(T.what + 8, Math.round(lead + share * span))
  const today = at(SHARE.today)
  const now = at(SHARE.now)
  return (
    <Scene exitFrames={14} clearBy={CLEAR_BY}>
      <Lockup frame={frame} />
      <NameCard frame={frame} />

      <div style={{ position: 'absolute', left: SAFE.x, right: SAFE.x, top: 192 }}>
        {/* What it is. */}
        <div style={{ ...enter(frame, T.what, { duration: 24, distance: 14 }), maxWidth: 1360, font: `400 54px/1.16 ${SERIF}`, color: C.head, letterSpacing: '-0.014em', textWrap: 'balance' }}>
          {WHAT}
        </div>
        <div style={{ ...enter(frame, T.what + 10, { duration: 22, distance: 10 }), marginTop: 14, font: `400 26px/1.35 ${SANS}`, color: C.soft }}>{WHAT_SUB}</div>

        {/* How it is done today, and with Rolepay, as on the home page: each column arrives whole. */}
        <div style={{ marginTop: 34 }}>
          <div style={{ display: 'flex', paddingBottom: 12 }}>
            <span style={{ ...label, ...enter(frame, today, { distance: 8 }), width: COL_A, color: C.meta }}>Today</span>
            <span style={{ ...label, ...enter(frame, now, { distance: 8 }), color: C.soft, display: 'inline-flex', alignItems: 'center', gap: 14 }}>
              <span style={{ width: 28, height: 2, borderRadius: 1, background: gold(0.9) }} />
              With Rolepay
            </span>
          </div>
          {CONTRAST.map((row, i) => {
            const was = today + i * CASCADE
            const is = now + i * CASCADE
            // Today's column steps back as the answers arrive, row by row.
            const recede = 1 - 0.35 * progress(frame, is, 20)
            return (
              <div key={row.was} style={{ display: 'flex', alignItems: 'baseline', padding: '14px 0 16px', borderTop: `1px solid ${white(0.09 * progress(frame, was, 16))}` }}>
                <span style={{ ...enter(frame, was, { duration: 20, distance: 10 }), opacity: progress(frame, was, 20) * recede, width: COL_A, paddingRight: 64, font: `400 25px/1.34 ${SANS}`, color: C.soft, textWrap: 'balance' }}>
                  {row.was}
                </span>
                <span style={{ ...enter(frame, is, { duration: 22, distance: 10 }), flex: 1, font: `400 33px/1.2 ${SERIF}`, color: C.head, letterSpacing: '-0.008em', textWrap: 'balance' }}>
                  <RichText text={row.now} />
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* The proof. */}
      <div style={{ position: 'absolute', left: SAFE.x, bottom: 100, display: 'flex', gap: 16 }}>
        {PROOF.map((p, i) => (
          <div
            key={p}
            style={{
              ...enter(frame, at(SHARE.proof) + i * 8, { duration: 18, distance: 8 }),
              height: 48,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 13,
              padding: '0 22px 0 18px',
              borderRadius: 24,
              background: gold(0.05),
              boxShadow: `inset 0 0 0 1px ${gold(0.32)}`,
              whiteSpace: 'nowrap',
            }}
          >
            {i === 0 ? <span style={{ width: 10, height: 10, borderRadius: 5, background: C.ok, boxShadow: `0 0 12px ${C.ok}` }} /> : <KeyIcon size={24} color={C.gold} strokeWidth={1.6} />}
            <span style={{ font: `500 22px/1 ${SANS}`, color: C.fg }}>{p}</span>
          </div>
        ))}
      </div>
    </Scene>
  )
}

/** The "Today" column's width: its label and its lines line up under it. */
const COL_A = 680

/**
 * The mark and the name: large in the middle as the title, drawing in, then settling into the
 * header at the top left (the place every scene's label takes), as the slide's content arrives.
 */
const Lockup: React.FC<{ frame: number }> = ({ frame }) => {
  const s = progress(frame, T.settle, SETTLE, EASE_IN_OUT)
  const anchor = mix(s, -50, 0)
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 960,
          top: 470,
          width: 900,
          height: 900,
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(closest-side, rgba(237,190,90,0.09), transparent)',
          opacity: progress(frame, T.fill, 14) * (1 - s),
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: mix(s, 960, SAFE.x),
          top: mix(s, 470, SAFE.y - 14),
          transform: `translate(${anchor}%, ${anchor}%)`,
          display: 'flex',
          alignItems: 'center',
          gap: mix(s, 32, 16),
        }}
      >
        <Mark
          size={mix(s, 136, 50)}
          tile={progress(frame, T.tile, 12)}
          outline={progress(frame, T.outline, 20, EASE_IN_OUT)}
          fill={progress(frame, T.fill, 10)}
          face={progress(frame, T.face, 10)}
        />
        <span style={{ ...enter(frame, T.word, { duration: 16, distance: 10 }), font: `400 ${mix(s, 120, 46)}px/1 ${SERIF}`, letterSpacing: '-0.015em', color: C.head }}>Rolepay</span>
      </div>
    </>
  )
}

/** "Filipe Aleixo, Founder", small, top right, with the portrait in a circle when there is one. */
const NameCard: React.FC<{ frame: number }> = ({ frame }) => {
  const portrait = PORTRAITS.find(hasAsset) ?? null
  return (
    <div style={{ position: 'absolute', right: SAFE.x, top: SAFE.y - 14, height: 50, display: 'flex', alignItems: 'center', gap: 18, ...enter(frame, T.header, { duration: 20, distance: 8 }) }}>
      {portrait ? (
        <Img src={staticFile(portrait)} style={{ width: 50, height: 50, borderRadius: 25, objectFit: 'cover', boxShadow: `0 0 0 1.5px ${gold(0.5)}` }} />
      ) : (
        <span style={{ width: 2, height: 42, borderRadius: 1, background: C.gold }} />
      )}
      <div>
        <div style={{ font: `400 28px/1.1 ${SERIF}`, color: C.head }}>Filipe Aleixo</div>
        <div style={{ marginTop: 6, ...label, font: `500 14px/1 ${SANS}`, color: C.meta }}>Founder</div>
      </div>
    </div>
  )
}
