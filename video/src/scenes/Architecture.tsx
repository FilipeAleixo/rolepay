import React from 'react'
import { useCurrentFrame } from 'remotion'
import { BlocksIcon } from '../components/Icons'
import { Scene } from '../components/Scene'
import { SANS, SERIF } from '../fonts'
import { EASE_IN_OUT, enter, progress } from '../motion'
import { C, gold, panel, sec, white } from '../theme'

export const ARCHITECTURE_FRAMES = sec(8)

/*
 * 8. Architecture, as docs/ARCHITECTURE.md describes it: apps/server is the composition root and
 * the only place that imports core's adapters; packages/discord and packages/web call core's
 * services only (and never each other); core is ports and adapters (services, a pure domain,
 * ports, and the adapters that implement them); Tempo sits underneath.
 */

type Box = { x: number; y: number; w: number; h: number }
const SERVER: Box = { x: 710, y: 196, w: 500, h: 104 }
const DISCORD: Box = { x: 260, y: 372, w: 500, h: 104 }
const WEB: Box = { x: 1160, y: 372, w: 500, h: 104 }
const CORE: Box = { x: 260, y: 556, w: 1400, h: 236 }
const CHAIN_Y = 868

const CELLS = [
  { name: 'services', desc: 'the only public interface' },
  { name: 'domain', desc: 'pure: money, memos, the run state machine' },
  { name: 'ports', desc: 'interfaces' },
  { name: 'adapters', desc: 'Tempo, SQLite, Anthropic, the key vault' },
] as const
const CELL_PAD = 26
const CELL_GAP = 18
const CELL_W = (CORE.w - 2 * CELL_PAD - 3 * CELL_GAP) / 4
const CELL_Y = CORE.y + 74

const T = { server: 6, discord: 20, web: 26, toApps: 34, core: 48, cells: [58, 64, 70, 76] as const, toCore: 80, wires: 88, chain: 104, toChain: 114 }

export const Architecture: React.FC = () => {
  const frame = useCurrentFrame()
  const draw = (start: number) => progress(frame, start, 18, EASE_IN_OUT)
  const adaptersX = CORE.x + CELL_PAD + 3 * (CELL_W + CELL_GAP) + CELL_W / 2
  return (
    <Scene kicker="Architecture">
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        <Connector d={`M840 ${SERVER.y + SERVER.h} V336 H510 V${DISCORD.y}`} t={draw(T.toApps)} />
        <Connector d={`M1080 ${SERVER.y + SERVER.h} V336 H1410 V${WEB.y}`} t={draw(T.toApps + 4)} />
        <Connector d={`M510 ${DISCORD.y + DISCORD.h} V${CORE.y}`} t={draw(T.toCore)} />
        <Connector d={`M1410 ${WEB.y + WEB.h} V${CORE.y}`} t={draw(T.toCore + 4)} />
        <Connector d={`M960 ${SERVER.y + SERVER.h} V${CORE.y}`} t={draw(T.wires)} dashed />
        <Connector d={`M${adaptersX} ${CORE.y + CORE.h} V${CHAIN_Y}`} t={draw(T.toChain)} gold />
      </svg>

      <BoxView box={SERVER} name="apps/server" desc="the composition root, on Hono" at={T.server} frame={frame} />
      <BoxView box={DISCORD} name="packages/discord" desc="Discord, over HTTP interactions" at={T.discord} frame={frame} />
      <BoxView box={WEB} name="packages/web" desc="passkey pages and the dashboard" at={T.web} frame={frame} />

      <ConnectorLabel x={524} y={CORE.y - 50} text="services only" at={T.toCore + 8} frame={frame} />
      <ConnectorLabel x={1424} y={CORE.y - 50} text="services only" at={T.toCore + 12} frame={frame} />
      <ConnectorLabel x={976} y={CORE.y - 50} text="wires the adapters" at={T.wires + 8} frame={frame} />
      <ConnectorLabel x={adaptersX + 14} y={CORE.y + CORE.h + 26} text="the bot key pays" at={T.toChain + 8} frame={frame} />

      {/* packages/core: ports and adapters. */}
      <div style={{ position: 'absolute', left: CORE.x, top: CORE.y, width: CORE.w, height: CORE.h, ...panel, ...enter(frame, T.core, { distance: 10 }) }}>
        <div style={{ position: 'absolute', left: CELL_PAD, top: 24, display: 'flex', alignItems: 'baseline', gap: 18 }}>
          <span style={{ font: `600 26px/1 ${SANS}`, color: C.head }}>packages/core</span>
          <span style={{ font: `400 20px/1 ${SANS}`, color: C.meta }}>ports and adapters</span>
        </div>
      </div>
      {CELLS.map((c, i) => {
        const adapters = c.name === 'adapters'
        return (
          <div
            key={c.name}
            style={{
              position: 'absolute',
              left: CORE.x + CELL_PAD + i * (CELL_W + CELL_GAP),
              top: CELL_Y,
              width: CELL_W,
              height: CORE.h - 74 - CELL_PAD,
              borderRadius: 14,
              padding: '20px 22px',
              background: adapters ? 'transparent' : white(0.03),
              boxShadow: adapters ? 'none' : `inset 0 1px 0 ${white(0.06)}`,
              border: adapters ? `1px dashed ${white(0.2)}` : '1px solid transparent',
              ...enter(frame, T.cells[i] ?? 0, { distance: 8 }),
            }}
          >
            <div style={{ font: `600 24px/1 ${SANS}`, color: adapters ? C.gold : C.head }}>{c.name}</div>
            <div style={{ marginTop: 14, font: `400 20px/1.4 ${SANS}`, color: C.soft }}>{c.desc}</div>
          </div>
        )
      })}

      {/* Tempo, underneath everything. */}
      <div
        style={{
          position: 'absolute',
          left: CORE.x,
          width: CORE.w,
          top: CHAIN_Y,
          height: 84,
          borderRadius: 16,
          background: gold(0.06),
          boxShadow: `inset 0 0 0 1.5px ${gold(0.4)}`,
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          padding: '0 30px',
          ...enter(frame, T.chain, { distance: 10 }),
        }}
      >
        <BlocksIcon size={34} color={C.gold} strokeWidth={1.5} />
        <span style={{ font: `400 38px/1 ${SERIF}`, color: C.head }}>Tempo</span>
        <span style={{ marginLeft: 'auto', font: `400 21px/1.3 ${SANS}`, color: C.soft }}>
          The treasurer's passkey signs in the browser. The bot signs only with its limited key.
        </span>
      </div>
    </Scene>
  )
}

const BoxView: React.FC<{ box: Box; name: string; desc: string; at: number; frame: number }> = ({ box, name, desc, at, frame }) => (
  <div
    style={{
      position: 'absolute',
      left: box.x,
      top: box.y,
      width: box.w,
      height: box.h,
      ...panel,
      borderRadius: 18,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 30px',
      ...enter(frame, at, { distance: 10 }),
    }}
  >
    <div style={{ font: `600 26px/1 ${SANS}`, color: C.head }}>{name}</div>
    <div style={{ marginTop: 12, font: `400 20px/1.2 ${SANS}`, color: C.meta }}>{desc}</div>
  </div>
)

const Connector: React.FC<{ d: string; t: number; dashed?: boolean; gold?: boolean }> = ({ d, t, dashed, gold: isGold }) => (
  <path
    d={d}
    pathLength={1}
    fill="none"
    stroke={isGold ? gold(0.7) : white(0.24)}
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeDasharray={dashed ? `${0.012} ${0.018}` : '1 1'}
    strokeDashoffset={dashed ? 0 : 1 - t}
    opacity={dashed ? t : t > 0 ? 1 : 0}
  />
)

const ConnectorLabel: React.FC<{ x: number; y: number; text: string; at: number; frame: number }> = ({ x, y, text, at, frame }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      font: `500 15px/1 ${SANS}`,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: C.meta,
      whiteSpace: 'nowrap',
      opacity: progress(frame, at, 14),
    }}
  >
    {text}
  </div>
)
