import { getLength, getPointAtLength } from '@remotion/paths'
import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { BotIcon, ClockIcon, FingerprintIcon, GaugeIcon, KeyIcon, MemoIcon, PersonIcon, VaultIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN, EASE_IN_OUT, EASE_OUT, enter, mix, progress } from '../motion'
import { C, gold, panel, sec, white } from '../theme'

export const TRUST_MODEL_FRAMES = sec(20)

/*
 * The trust model in one picture. Left to right: the community's own Tempo account (its root key
 * is the treasurer's passkey), the bot with the access key that root authorised (three limits),
 * the chain, and three people. A batch inside the limit is paid; a batch over what is left hits the
 * chain's line and is refused whole. Every coordinate is on the 1920 by 1080 frame.
 */

// Timing, in frames.
const T = {
  treasury: 6,
  root: 26,
  bot: 60,
  key: 88,
  pills: [124, 140, 156] as const,
  chain: 186,
  people: [200, 208, 216] as const,
  batch1: 250,
  batch2: 342,
  dim: 466,
  closing: 484,
}
const TRAVEL = 40 // a batch-1 dot, from the bot to its person
const STAGGER = 4 // between the dots of one batch
const STOP = 26 // a batch-2 dot, from the bot to the chain's line
const REFUSED = T.batch2 + STOP

// Geometry.
const A_X = 160 // the treasury column
const B_X = 720 // the bot column
const COL_TOP = 250
const ROW_Y = 556 // the root key, the access key and the batch all sit on this line
const CHIP_W = 440
const CHAIN_X = 1320
const BATCH_START = B_X + CHIP_W + 16
const PEOPLE_X = 1440
const AVATAR = 64
const PEOPLE_Y = [352, 488, 624] as const
const PEOPLE = ['Moderator', 'Staff', 'Bounty winner'] as const

const fanPath = (y: number) => `M${BATCH_START} ${ROW_Y} L${CHAIN_X} ${ROW_Y} C${CHAIN_X + 60} ${ROW_Y} ${CHAIN_X + 64} ${y} ${PEOPLE_X - 8} ${y}`
const FANS = PEOPLE_Y.map((y) => {
  const d = fanPath(y)
  return { d, length: getLength(d) }
})

export const TrustModel: React.FC = () => {
  const frame = useCurrentFrame()
  const dim = 1 - 0.62 * progress(frame, T.dim, 22)
  return (
    <Scene kicker="The trust model">
      <AbsoluteFill style={{ opacity: dim }}>
        <Treasury frame={frame} />
        <Bot frame={frame} />
        <Flows frame={frame} />
        <People frame={frame} />
      </AbsoluteFill>
      <Captions frame={frame} />
    </Scene>
  )
}

const tile: React.CSSProperties = {
  ...panel,
  width: 104,
  height: 104,
  borderRadius: 26,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const title: React.CSSProperties = { font: `400 46px/1.1 ${SERIF}`, color: C.head, letterSpacing: '-0.012em', whiteSpace: 'nowrap' }
const sub: React.CSSProperties = { font: `400 24px/1.3 ${SANS}`, color: C.meta, whiteSpace: 'nowrap' }
const label: React.CSSProperties = { font: `500 15px/1 ${SANS}`, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.meta }

const Treasury: React.FC<{ frame: number }> = ({ frame }) => {
  const ring = progress(frame, T.root, 18)
  return (
    <>
      <div style={{ position: 'absolute', left: A_X, top: COL_TOP, ...enter(frame, T.treasury) }}>
        <div style={tile}>
          <VaultIcon size={50} color={C.soft} strokeWidth={1.4} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: A_X, top: COL_TOP + 134, ...enter(frame, T.treasury + 5) }}>
        <div style={title}>Community treasury</div>
        <div style={{ ...sub, marginTop: 14 }}>Its own Tempo account</div>
      </div>
      {/* The root key: the treasurer's passkey. */}
      <div style={{ position: 'absolute', left: A_X, top: ROW_Y - 36, display: 'flex', alignItems: 'center', gap: 20, opacity: ring }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `inset 0 0 0 1.5px ${gold(0.55)}`,
            background: gold(0.06),
          }}
        >
          <FingerprintIcon size={40} color={C.gold} strokeWidth={1.4} draw={progress(frame, T.root, 34, EASE_IN_OUT)} />
        </div>
        <div style={enter(frame, T.root + 8, { distance: 10 })}>
          <div style={label}>Root key</div>
          <div style={{ marginTop: 10, font: `400 23px/1.2 ${SANS}`, color: C.fg, whiteSpace: 'nowrap' }}>The treasurer's passkey</div>
        </div>
      </div>
    </>
  )
}

const PILLS = [
  { Icon: ClockIcon, text: 'expires' },
  { Icon: GaugeIcon, text: '100 / 30 days' },
  { Icon: MemoIcon, text: "only memo'd transfers of one token" },
] as const

const Bot: React.FC<{ frame: number }> = ({ frame }) => {
  // The connector from the root key: the root authorises the access key.
  const link = progress(frame, T.key, 20, EASE_IN_OUT)
  const chip = progress(frame, T.key + 6, 24)
  // What the key has left this period: 100, then 25 after the first batch.
  const spent = progress(frame, T.batch1 + TRAVEL - 6, 24, EASE_IN_OUT)
  const left = Math.round(100 - 75 * spent)
  const linkFrom = A_X + 430
  const linkTo = B_X - 16
  return (
    <>
      <div style={{ position: 'absolute', left: B_X, top: COL_TOP, ...enter(frame, T.bot) }}>
        <div style={tile}>
          <BotIcon size={50} color={C.soft} strokeWidth={1.4} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: B_X, top: COL_TOP + 134, ...enter(frame, T.bot + 5) }}>
        <div style={title}>Rolepay bot</div>
        <div style={{ ...sub, marginTop: 14 }}>Holds only an access key</div>
      </div>

      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        <line x1={linkFrom} y1={ROW_Y} x2={mix(link, linkFrom, linkTo)} y2={ROW_Y} stroke={gold(0.55)} strokeWidth={1.5} strokeDasharray="2 7" strokeLinecap="round" />
        <path d={`M${linkTo - 9} ${ROW_Y - 7} L${linkTo} ${ROW_Y} L${linkTo - 9} ${ROW_Y + 7}`} fill="none" stroke={gold(0.7)} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={progress(frame, T.key + 16, 8)} />
      </svg>
      <div style={{ position: 'absolute', left: linkFrom, width: linkTo - linkFrom, top: ROW_Y - 40, textAlign: 'center', ...label, font: `500 14px/1 ${SANS}`, opacity: progress(frame, T.key + 8, 14) }}>
        authorises
      </div>

      {/* The access key, handed to the bot. */}
      <div
        style={{
          position: 'absolute',
          left: B_X,
          top: ROW_Y - 36,
          width: CHIP_W,
          height: 72,
          borderRadius: 18,
          background: gold(0.075),
          boxShadow: `inset 0 0 0 1.5px ${gold(0.42)}, inset 0 1px 0 ${gold(0.25)}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          gap: 16,
          overflow: 'hidden',
          opacity: chip,
          transform: `translateX(${mix(chip, -60, 0)}px)`,
        }}
      >
        <KeyIcon size={34} color={C.gold} strokeWidth={1.5} />
        <span style={{ font: `500 25px/1 ${SANS}`, color: C.head }}>Access key</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ font: `400 34px/1 ${SERIF}`, color: C.gold, fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'right' }}>{left}</span>
          <span style={{ font: `400 19px/1 ${SANS}`, color: C.meta }}>left</span>
        </span>
        <div style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: `${left}%`, background: gold(0.75) }} />
      </div>

      {/* Its three limits. */}
      {PILLS.map(({ Icon, text }, i) => (
        <div
          key={text}
          style={{
            position: 'absolute',
            left: B_X,
            top: ROW_Y + 56 + i * 54,
            height: 42,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 18px 0 14px',
            borderRadius: 21,
            boxShadow: `inset 0 0 0 1px ${white(0.13)}`,
            background: white(0.025),
            whiteSpace: 'nowrap',
            ...enter(frame, T.pills[i] ?? 0, { duration: 16, distance: 10 }),
          }}
        >
          <Icon size={20} color={C.gold} strokeWidth={1.6} />
          <span style={{ font: `500 20px/1 ${SANS}`, color: C.fg }}>{text}</span>
        </div>
      ))}
    </>
  )
}

const Flows: React.FC<{ frame: number }> = ({ frame }) => {
  const line = progress(frame, T.chain, 24, EASE_IN_OUT)
  // The chain's line flares when the over-limit batch hits it, then stays hard.
  const flare = progress(frame, REFUSED, 6, EASE_OUT) * (1 - 0.55 * progress(frame, REFUSED + 6, 26, EASE_OUT))
  const hard = progress(frame, REFUSED, 8)
  const top = 236
  const bottom = 780
  const fade1 = 1 - 0.55 * progress(frame, T.batch2 - 10, 16) // batch 1's trails step back for batch 2
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <defs>
          <filter id="flare" x="-200%" y="-20%" width="500%" height="140%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>
        {/* Faint guides to each person, once they are on screen. */}
        {FANS.map((f, i) => (
          <path key={i} d={f.d} fill="none" stroke={white(0.07)} strokeWidth={1.5} opacity={progress(frame, T.people[i] ?? 0, 16)} />
        ))}
        {/* Batch 1: each dot leaves a gold trail. */}
        {FANS.map((f, i) => {
          const t = progress(frame, T.batch1 + i * STAGGER, TRAVEL, EASE_IN_OUT)
          return (
            <path
              key={`trail-${i}`}
              d={f.d}
              fill="none"
              stroke={gold(0.5 * fade1)}
              strokeWidth={2}
              strokeDasharray={`${f.length} ${f.length}`}
              strokeDashoffset={f.length * (1 - t)}
              opacity={t > 0 ? 1 : 0}
            />
          )
        })}
        {/* The chain: a hard gold line. */}
        <line x1={CHAIN_X} y1={top} x2={CHAIN_X} y2={mix(line, top, bottom)} stroke={gold(0.42 + 0.53 * hard)} strokeWidth={2 + 1.5 * hard} strokeLinecap="round" />
        <line x1={CHAIN_X} y1={top + 40} x2={CHAIN_X} y2={bottom - 40} stroke={gold(0.9)} strokeWidth={10} filter="url(#flare)" opacity={flare} />
        {/* Batch 1 dots, then batch 2 dots, which stop at the line. */}
        {FANS.map((f, i) => {
          const t = progress(frame, T.batch1 + i * STAGGER, TRAVEL, EASE_IN_OUT)
          if (t <= 0 || t >= 1) return null
          const p = getPointAtLength(f.d, f.length * t)
          return p ? <circle key={`d1-${i}`} cx={p.x} cy={p.y} r={7} fill={C.gold} /> : null
        })}
        {[0, 1, 2].map((i) => {
          const t = progress(frame, T.batch2 + i * STAGGER, STOP, EASE_OUT)
          if (t <= 0) return null
          const grey = progress(frame, REFUSED + 4, 12)
          const gone = progress(frame, REFUSED + 16, 20, EASE_IN)
          const x = mix(t, BATCH_START, CHAIN_X - 14 - i * 17) - 10 * gone
          const color = grey > 0.5 ? C.meta : C.gold
          return <circle key={`d2-${i}`} cx={x} cy={ROW_Y} r={7} fill={color} opacity={(1 - 0.5 * grey) * (1 - gone)} />
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: CHAIN_X - 150,
          width: 300,
          top: top - 44,
          textAlign: 'center',
          font: `600 16px/1 ${SANS}`,
          letterSpacing: '0.26em',
          textTransform: 'uppercase',
          color: C.gold,
          opacity: progress(frame, T.chain + 6, 16),
        }}
      >
        Tempo
      </div>
      <BatchLabel frame={frame} start={T.batch1} text="3 × 25" travel={TRAVEL * 0.42} />
      <BatchLabel frame={frame} start={T.batch2} text="3 × 20" travel={STOP} stopAt={CHAIN_X - 40} />
    </>
  )
}

/** The batch's size, riding just above its first dot along the straight run to the chain. */
const BatchLabel: React.FC<{ frame: number; start: number; text: string; travel: number; stopAt?: number }> = ({ frame, start, text, travel, stopAt }) => {
  const t = progress(frame, start, travel, stopAt ? EASE_OUT : EASE_IN)
  const shown = progress(frame, start, 8) * (stopAt ? 1 - progress(frame, REFUSED + 16, 20, EASE_IN) : 1 - progress(frame, start + travel - 4, 8))
  const x = mix(t, BATCH_START + 6, stopAt ?? CHAIN_X - 30)
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 70,
        width: 140,
        top: ROW_Y - 44,
        textAlign: 'center',
        font: `500 19px/1 ${SANS}`,
        color: C.gold,
        fontVariantNumeric: 'tabular-nums',
        opacity: shown,
      }}
    >
      {text}
    </div>
  )
}

const People: React.FC<{ frame: number }> = ({ frame }) => (
  <>
    {PEOPLE.map((name, i) => {
      const paid = progress(frame, T.batch1 + i * STAGGER + TRAVEL - 2, 12)
      const y = PEOPLE_Y[i] ?? 0
      return (
        <div key={name} style={{ position: 'absolute', left: PEOPLE_X, top: y - AVATAR / 2, display: 'flex', alignItems: 'center', gap: 22, ...enter(frame, T.people[i] ?? 0, { distance: 10 }) }}>
          <div
            style={{
              width: AVATAR,
              height: AVATAR,
              borderRadius: AVATAR / 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: white(0.03),
              boxShadow: `inset 0 0 0 1.5px ${paid > 0 ? gold(0.25 + 0.4 * paid) : white(0.14)}`,
            }}
          >
            <PersonIcon size={32} color={C.soft} strokeWidth={1.5} />
          </div>
          <div>
            <div style={{ font: `400 25px/1.15 ${SANS}`, color: C.fg, whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ marginTop: 6, height: 26, font: `400 24px/1.1 ${SERIF}`, color: C.gold, opacity: paid, transform: `translateY(${mix(paid, 6, 0)}px)` }}>+25</div>
          </div>
        </div>
      )
    })}
  </>
)

const Captions: React.FC<{ frame: number }> = ({ frame }) => {
  const out = 1 - progress(frame, T.dim + 2, 12, EASE_IN)
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 846, textAlign: 'center', opacity: out }}>
        <div style={{ ...enter(frame, REFUSED + 6, { duration: 22, distance: 12 }), font: `400 56px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
          Refused by the chain, <span style={{ color: C.gold }}>not by our code</span>
        </div>
        <div style={{ ...enter(frame, REFUSED + 22, { duration: 20, distance: 10 }), marginTop: 20, font: `400 25px/1.3 ${SANS}`, color: C.soft }}>
          Each line fits what is left. The batch does not. Nobody is paid.
        </div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 870, textAlign: 'center' }}>
        <div style={{ ...enter(frame, T.closing, { duration: 24, distance: 14 }), font: `400 58px/1.15 ${SERIF}`, color: C.head, letterSpacing: '-0.012em' }}>
          A compromised bot can lose at most <span style={{ color: C.gold }}>one period's budget.</span>
        </div>
      </div>
    </>
  )
}
