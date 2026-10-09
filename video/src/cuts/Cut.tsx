import React from 'react'
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { Ground } from '../components/Ground'
import { RichText } from '../components/RichText'
import { SANS } from '../fonts'
import { EASE_IN, EASE_IN_OUT, EASE_OUT, mix } from '../motion'
import { C, white } from '../theme'
import { EndCard, TitleCard } from './Cards'
import { BEATS, type Beat, type BeatId, type Box, type Panel, type Patch, SOURCE, type Shot, boxAt, fit, sourceAt, stackedY } from './footage'

/** Where everything sits on the canvas (pixels). */
export type Layout = {
  /** Side margin, and the gap between two panels. */
  marginX: number
  gap: number
  /** Every panel's top edge and height; two panels share the width between the margins. */
  panelTop: number
  panelH: number
  radius: number
  labelSize: number
  /** The caption: a headline and a line under it, centred on these y; then the progress marker. */
  headlineY: number
  headlineSize: number
  sublineY: number
  sublineSize: number
  progressY: number
  /** The size of the small things (rings, rules, card type), relative to 1920 by 1080. */
  unit: number
}

export type CutProps = {
  layout: Layout
  beats: BeatId[]
  /** The crossfade between two segments, in seconds. */
  fade: number
  /** The end card crossfades into the title card, so the last frame flows into frame 0. */
  loop: boolean
  /** Seconds of the title card before the beats and of the end card after them. */
  title: number
  end: number
  /** The end card repeats the promise over the link (the X cut). */
  endPromise: boolean
}

/** A dissolve between two shots of one panel, in seconds. */
const SHOT_DISSOLVE = 0.35

type Segment = { kind: 'beat'; id: BeatId; index: number; frames: number } | { kind: 'title' | 'end'; frames: number }

const segmentsOf = ({ beats, title, end }: CutProps, fps: number): Segment[] => [
  { kind: 'title', frames: Math.round(title * fps) },
  ...beats.map((id, index) => ({ kind: 'beat' as const, id, index, frames: Math.round(BEATS[id].seconds * fps) })),
  { kind: 'end', frames: Math.round(end * fps) },
]

/** A cut's length in frames: each segment's own; a crossfade borrows the previous segment's tail. */
export const cutFrames = (props: CutProps, fps: number) => segmentsOf(props, fps).reduce((a, s) => a + s.frames, 0)

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** 0 before `start`, 1 after `start + duration` (seconds), eased in between. */
const ramp = (t: number, start: number, duration: number, ease = EASE_OUT) => ease(clamp01((t - start) / duration))

/**
 * A cut of the mainnet recording: the title card, the beats, the end card, each a full picture
 * crossfading into the next. A beat is one or two labelled panels of the recording (same height,
 * same top edge), with its caption and a quiet progress marker under them.
 */
export const Cut: React.FC<CutProps> = (props) => {
  const { layout, loop } = props
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const fade = Math.round(props.fade * fps)
  const total = cutFrames(props, fps)
  let at = 0
  const segments = segmentsOf(props, fps).map((s) => {
    const placed = { ...s, start: at }
    at += s.frames
    return placed
  })

  // Every segment on screen, with its local frame (0 = fully on; negative while it fades in over
  // the previous one). With `loop`, the title card also fades in over the end.
  const visible: { key: string; local: number; s: (typeof segments)[number] }[] = []
  segments.forEach((s, i) => {
    const local = frame - s.start
    if (local >= -fade && local < s.frames) visible.push({ key: `s${i}`, local, s })
  })
  const first = segments[0]!
  if (loop && frame >= total - fade) visible.push({ key: 'wrap', local: frame - total, s: first })

  /** How much of the picture a segment is: 1 while on, rising through its fade-in, falling through the next one's. */
  const presence = (local: number, frames: number) => {
    if (local < 0) return clamp01((local + fade) / fade)
    if (local >= frames - fade) return 1 - clamp01((local - (frames - fade)) / fade)
    return 1
  }

  const beatsOn = visible.filter((v) => v.s.kind === 'beat')
  const markerWeights = props.beats.map((_, j) =>
    beatsOn.filter((v) => v.s.kind === 'beat' && v.s.index === j).reduce((a, v) => a + presence(v.local, v.s.frames), 0),
  )

  return (
    <AbsoluteFill style={{ backgroundColor: C.ink }}>
      <EvenFilter />
      {visible.map(({ key, local, s }) => {
        // Each picture is opaque and drawn over the one before: a true crossfade.
        const opacity = local < 0 ? clamp01((local + fade) / fade) : 1
        const t = local / fps
        return (
          <AbsoluteFill key={key} style={{ opacity }}>
            {s.kind === 'beat' ? (
              <BeatPicture beat={BEATS[s.id]} t={t} layout={layout} />
            ) : s.kind === 'title' ? (
              <TitleCard t={Math.max(0, t)} unit={layout.unit} />
            ) : (
              <EndCard t={t + props.fade} unit={layout.unit} promise={props.endPromise} />
            )}
          </AbsoluteFill>
        )
      })}
      {visible.map(({ key, local, s }) => {
        if (s.kind !== 'beat') return null
        const t = local / fps
        const half = props.fade / 2
        // In over the second half of the crossfade into it, out over the first half of the one out.
        const enter = ramp(t, -half, half + 0.05)
        const exit = ramp(t, s.frames / fps - props.fade, half, EASE_IN)
        return <CaptionBlock key={`c${key}`} beat={BEATS[s.id]} enter={enter} exit={exit} layout={layout} />
      })}
      <ProgressMarker weights={markerWeights} layout={layout} />
    </AbsoluteFill>
  )
}

/** A beat's picture: the ground and its panels, each with its label. */
const BeatPicture: React.FC<{ beat: Beat; t: number; layout: Layout }> = ({ beat, t, layout }) => {
  const { width } = useVideoConfig()
  const room = width - 2 * layout.marginX
  const geometry =
    beat.panels.length === 2
      ? [0, 1].map((i) => {
          const w = (room - layout.gap) / 2
          return { left: layout.marginX + i * (w + layout.gap), w }
        })
      : beat.panels.map((p) => {
          const w = Math.min(room, layout.panelH * (p.aspect ?? 1.6))
          return { left: (width - w) / 2, w }
        })
  return (
    <AbsoluteFill>
      <Ground />
      {beat.panels.map((panel, i) => (
        <PanelView key={i} panel={panel} t={t} left={geometry[i]!.left} w={geometry[i]!.w} layout={layout} />
      ))}
    </AbsoluteFill>
  )
}

const accentOf = (panel: Panel) => (panel.accent === 'gold' ? C.gold : C.periwinkle)

/** A label, then the panel's frame holding its shots; a later shot dissolves in over the one before. */
const PanelView: React.FC<{ panel: Panel; t: number; left: number; w: number; layout: Layout }> = ({ panel, t, left, w, layout }) => {
  const h = layout.panelH
  const u = layout.unit
  const accent = accentOf(panel)
  const starts = panel.shots.map((s) => s.from ?? 0)
  let k = 0
  starts.forEach((s, i) => {
    if (t >= s) k = i
  })
  const shown: { shot: Shot; opacity: number }[] = []
  const incoming = k > 0 ? clamp01((t - starts[k]!) / SHOT_DISSOLVE) : 1
  if (k > 0 && incoming < 1) shown.push({ shot: panel.shots[k - 1]!, opacity: 1 })
  shown.push({ shot: panel.shots[k]!, opacity: EASE_IN_OUT(incoming) })
  return (
    <>
      <div style={{ position: 'absolute', left: left + 2 * u, top: layout.panelTop - layout.labelSize * 1.95, display: 'flex', alignItems: 'center', gap: layout.labelSize * 0.7 }}>
        <div style={{ width: layout.labelSize * 1.4, height: Math.max(1, 2 * u), borderRadius: 1, background: accent, opacity: 0.85 }} />
        <span style={{ font: `500 ${layout.labelSize}px/1 ${SANS}`, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.meta }}>{panel.label}</span>
      </div>
      <div
        style={{
          position: 'absolute',
          left,
          top: layout.panelTop,
          width: w,
          height: h,
          borderRadius: layout.radius,
          overflow: 'hidden',
          backgroundColor: panel.bg,
          boxShadow: `0 ${34 * u}px ${70 * u}px -${36 * u}px rgba(0,0,0,0.95), 0 0 0 1px rgba(0,0,0,0.55)`,
        }}
      >
        {shown.map(({ shot, opacity }, i) => (
          <ShotView key={`${k}:${i}`} shot={shot} panel={panel} t={t} w={w} h={h} opacity={opacity} unit={u} />
        ))}
        <div style={{ position: 'absolute', inset: 0, borderRadius: layout.radius, boxShadow: `inset 0 0 0 1px ${white(0.075)}`, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, background: `linear-gradient(90deg, transparent 4%, ${accent} 32%, transparent 88%)`, opacity: 0.45 }} />
      </div>
    </>
  )
}

/**
 * One shot: the recording at this moment, moved and scaled so the camera fills the panel, masked
 * to its clip (every edge fading inward, never past the window's page), with its patches and the
 * rings of its highlights.
 */
const ShotView: React.FC<{ shot: Shot; panel: Panel; t: number; w: number; h: number; opacity: number; unit: number }> = ({ shot, panel, t, w, h, opacity, unit }) => {
  const { fps } = useVideoConfig()
  const cam = fit(boxAt(shot.camera, t, EASE_IN_OUT), w / h)
  const s = w / (cam.x1 - cam.x0)
  const time = sourceAt(shot, t)
  const raw = boxAt(shot.clip, t, EASE_IN_OUT)
  const b = panel.bounds
  const clip = shot.rows
    ? { x0: Math.max(raw.x0, b.x0), x1: Math.min(raw.x1, b.x1), y0: raw.y0, y1: raw.y1 }
    : { x0: Math.max(raw.x0, b.x0), x1: Math.min(raw.x1, b.x1), y0: Math.max(raw.y0, b.y0), y1: Math.min(raw.y1, b.y1) }
  const px = (x: number) => (x - cam.x0) * s
  const py = (y: number) => (y - cam.y0) * s
  const fx = shot.feather.x * s
  const fy = shot.feather.y * s
  const mask = [
    `linear-gradient(to bottom, transparent ${py(clip.y0)}px, #000 ${py(clip.y0) + fy}px, #000 ${py(clip.y1) - fy}px, transparent ${py(clip.y1)}px)`,
    `linear-gradient(to right, transparent ${px(clip.x0)}px, #000 ${px(clip.x0) + fx}px, #000 ${px(clip.x1) - fx}px, transparent ${px(clip.x1)}px)`,
  ].join(', ')
  const rows = shot.rows ?? [[cam.y0, cam.y1] as const]
  let offset = 0
  const strips = rows.map(([r0, r1]) => {
    const strip = shot.rows ? { top: py(offset), height: (r1 - r0) * s, srcTop: r0 } : { top: 0, height: h, srcTop: cam.y0 }
    offset += r1 - r0
    return strip
  })
  const patches = (shot.patches ?? []).filter((p) => time >= p.from && time <= p.to)
  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill style={{ maskImage: mask, WebkitMaskImage: mask, maskComposite: 'intersect', WebkitMaskComposite: 'source-in', maskRepeat: 'no-repeat' }}>
        {strips.map((strip, i) => (
          <div key={i} style={{ position: 'absolute', left: 0, top: strip.top, width: w, height: strip.height, overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: SOURCE.width,
                height: SOURCE.height,
                transformOrigin: '0 0',
                transform: `translate(${-cam.x0 * s}px, ${-strip.srcTop * s}px) scale(${s})`,
                isolation: 'isolate',
              }}
            >
              <Frame time={time} fps={fps} />
              {patches.map((p, j) => (
                <PatchView key={j} patch={p} time={time} fps={fps} />
              ))}
            </div>
          </div>
        ))}
      </AbsoluteFill>
      {(shot.highlights ?? []).map((hl, i) => {
        const o = ramp(t, hl.from, 0.4) * (1 - ramp(t, hl.to - 0.45, 0.45, EASE_IN))
        if (o <= 0) return null
        return <Ring key={i} box={{ x0: px(hl.box.x0), x1: px(hl.box.x1), y0: py(stackedY(shot, hl.box.y0)), y1: py(stackedY(shot, hl.box.y1)) }} opacity={o * opacity} unit={unit} />
      })}
    </AbsoluteFill>
  )
}

/** The whole recording at `time` (seconds), in source pixels. Frozen at frame 0 and trimmed to `time`: a Freeze alone cannot reach past the cut's own length. */
const Frame: React.FC<{ time: number; fps: number; style?: React.CSSProperties }> = ({ time, fps, style }) => (
  <Freeze frame={0}>
    <OffthreadVideo src={staticFile(SOURCE.file)} trimBefore={time * fps} muted style={{ position: 'absolute', left: 0, top: 0, width: SOURCE.width, height: SOURCE.height, display: 'block', ...style }} />
  </Freeze>
)

const PatchView: React.FC<{ patch: Patch; time: number; fps: number }> = ({ patch, time, fps }) => {
  const { box } = patch
  const place = { position: 'absolute', left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 } as const
  if ('fill' in patch) return <div style={{ ...place, background: patch.fill }} />
  return (
    <div style={{ ...place, overflow: 'hidden', filter: patch.even ? `url(#${EVEN_FILTER})` : undefined }}>
      <Frame time={patch.plate ?? time} fps={fps} style={{ left: -box.x0, top: -box.y0 }} />
    </div>
  )
}

/**
 * The filter behind `even` patches: every channel darker than text (up to 0.17, which takes the
 * edge line and the counter's faint halo too) becomes the card's colour as the frames render
 * (18, 18, 20); from 0.21 up, the glyphs, everything passes as it is, with a ramp between.
 */
const EVEN_FILTER = 'cuts-even'
const evenTable = (floor: number) =>
  Array.from({ length: 101 }, (_, i) => {
    const v = i / 100
    return v <= 0.17 ? floor : v >= 0.21 ? v : floor + ((v - 0.17) / 0.04) * (0.21 - floor)
  })
    .map((v) => v.toFixed(4))
    .join(' ')

const EvenFilter: React.FC = () => (
  <svg width={0} height={0} style={{ position: 'absolute' }}>
    <defs>
      <filter id={EVEN_FILTER} colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR type="table" tableValues={evenTable(18 / 255)} />
          <feFuncG type="table" tableValues={evenTable(18 / 255)} />
          <feFuncB type="table" tableValues={evenTable(20 / 255)} />
        </feComponentTransfer>
      </filter>
    </defs>
  </svg>
)

/** A calm ring: a thin gold line and a soft glow, a little outside the element. */
const Ring: React.FC<{ box: Box; opacity: number; unit: number }> = ({ box, opacity, unit }) => {
  const pad = 7 * unit
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x0 - pad,
        top: box.y0 - pad,
        width: box.x1 - box.x0 + 2 * pad,
        height: box.y1 - box.y0 + 2 * pad,
        borderRadius: 12 * unit,
        opacity,
        boxShadow: `0 0 0 ${Math.max(1, 1.6 * unit)}px rgba(237,190,90,0.62), 0 0 ${26 * unit}px ${3 * unit}px rgba(237,190,90,0.16), inset 0 0 ${18 * unit}px rgba(237,190,90,0.06)`,
        pointerEvents: 'none',
      }}
    />
  )
}

/** The caption: the headline in white with its gold words, the line under it in grey; it rises a little in and drifts out. */
const CaptionBlock: React.FC<{ beat: Beat; enter: number; exit: number; layout: Layout }> = ({ beat, enter, exit, layout }) => {
  const opacity = enter * (1 - exit)
  if (opacity <= 0) return null
  const dy = mix(enter, 10 * layout.unit, 0) - 6 * layout.unit * exit
  const line = (y: number): React.CSSProperties => ({ position: 'absolute', left: 0, right: 0, top: y, textAlign: 'center', transform: `translateY(-50%) translateY(${dy}px)`, opacity })
  return (
    <>
      <div style={{ ...line(layout.headlineY), font: `500 ${layout.headlineSize}px/1.2 ${SANS}`, letterSpacing: '-0.006em', color: C.head }}>
        <RichText text={beat.headline} />
      </div>
      <div style={{ ...line(layout.sublineY), font: `400 ${layout.sublineSize}px/1.3 ${SANS}`, color: C.soft }}>{beat.subline}</div>
    </>
  )
}

/** Four short bars, the current beat's in periwinkle; it fades away on the title and end cards. */
const ProgressMarker: React.FC<{ weights: number[]; layout: Layout }> = ({ weights, layout }) => {
  const shown = Math.min(1, weights.reduce((a, b) => a + b, 0))
  if (shown <= 0) return null
  const u = layout.unit
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: layout.progressY, display: 'flex', justifyContent: 'center', gap: 10 * u, opacity: shown, transform: 'translateY(-50%)' }}>
      {weights.map((wgt, i) => (
        <div key={i} style={{ width: 30 * u, height: Math.max(2, 3 * u), borderRadius: 2 * u, background: white(0.14), overflow: 'hidden' }}>
          <div style={{ width: '100%', height: '100%', background: C.periwinkle, opacity: Math.min(1, wgt) * 0.95 }} />
        </div>
      ))}
    </div>
  )
}
