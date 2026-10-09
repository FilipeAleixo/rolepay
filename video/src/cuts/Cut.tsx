import React from 'react'
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { Ground } from '../components/Ground'
import { RichText } from '../components/RichText'
import { SANS, SERIF } from '../fonts'
import { EASE_IN, mix, progress } from '../motion'
import { C, white } from '../theme'
import { EndCard, TitleCard } from './Cards'
import { BEATS, type Beat, type BeatId, type Panel, SOURCE, sourceAt } from './footage'

/** Where the panels and the caption sit on the canvas (pixels). */
export type Layout = {
  /** Side margin and the gap between two panels. */
  marginX: number
  gap: number
  /** The panels' top edge and their tallest height; their labels sit just above. */
  panelTop: number
  panelMaxH: number
  radius: number
  labelSize: number
  /** The caption's vertical centre, under the panels. */
  captionY: number
  captionSize: number
}

export type CutProps = {
  layout: Layout
  beats: BeatId[]
  /** The crossfade between two segments, in seconds. */
  fade: number
  /** The last beat crossfades into the first, so the last frame flows into frame 0. */
  loop: boolean
  /** Seconds of a title card before the beats, and of an end card after them (0 for none). */
  title: number
  end: number
}

type Segment = { kind: 'beat'; id: BeatId; frames: number } | { kind: 'title' | 'end'; frames: number }

const segmentsOf = ({ beats, title, end }: CutProps, fps: number): Segment[] => [
  ...(title > 0 ? [{ kind: 'title' as const, frames: Math.round(title * fps) }] : []),
  ...beats.map((id) => ({ kind: 'beat' as const, id, frames: Math.round(BEATS[id].seconds * fps) })),
  ...(end > 0 ? [{ kind: 'end' as const, frames: Math.round(end * fps) }] : []),
]

/** A cut's length in frames: each segment's own; a crossfade borrows the previous segment's tail. */
export const cutFrames = (props: CutProps, fps: number) => segmentsOf(props, fps).reduce((a, s) => a + s.frames, 0)

/**
 * A short cut of the mainnet recording. Each beat is a full picture (the ink ground, one or two
 * labelled panels of the recording, scaled to fit) and crossfades into the next; the caption,
 * with its step number, leaves over the first half of a crossfade and arrives over the second.
 * A segment is fully on from its start; the crossfade into the next takes its last `fade` seconds.
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

  // Every segment on screen, with its local frame (0 = fully on). With `loop`, the first beat also
  // fades in over the end, at local frames -fade..-1, so the last frame leads into frame 0.
  const visible: { i: number; local: number; s: (typeof segments)[number] }[] = []
  segments.forEach((s, i) => {
    const local = frame - s.start
    if (local >= -fade && local < s.frames) visible.push({ i, local, s })
  })
  const first = segments[0]
  if (loop && first && frame >= total - fade) visible.push({ i: 0, local: frame - total, s: first })
  const hasNext = (i: number) => i < segments.length - 1 || loop
  const linear = (t: number) => t

  return (
    <AbsoluteFill style={{ backgroundColor: C.ink }}>
      {visible.map(({ i, local, s }) => {
        // Each picture is opaque and drawn over the one before, so this is a true crossfade.
        const opacity = local < 0 ? progress(local, -fade, fade, linear) : 1
        return (
          <AbsoluteFill key={`p${i}`} style={{ opacity }}>
            {s.kind === 'beat' ? (
              <BeatPicture beat={BEATS[s.id]} t={local / fps} layout={layout} />
            ) : s.kind === 'title' ? (
              <TitleCard frame={Math.max(0, local)} />
            ) : (
              <EndCard frame={local + fade} />
            )}
          </AbsoluteFill>
        )
      })}
      {visible.map(({ i, local, s }) => {
        if (s.kind !== 'beat') return null
        const afterBeat = i === 0 ? loop : segments[i - 1]?.kind === 'beat'
        const enter = afterBeat ? progress(local, -0.5 * fade, 0.5 * fade) : progress(local, 0.1 * fps, 0.45 * fps)
        const exit = hasNext(i) ? progress(local, s.frames - fade, 0.5 * fade, EASE_IN) : 0
        return <StepCaption key={`c${i}`} beat={BEATS[s.id]} enter={enter} exit={exit} layout={layout} />
      })}
    </AbsoluteFill>
  )
}

/**
 * One beat's picture: its panels side by side at one scale (the largest that fits the width and
 * the height), centred, each with its label above it.
 */
const BeatPicture: React.FC<{ beat: Beat; t: number; layout: Layout }> = ({ beat, t, layout }) => {
  const { width } = useVideoConfig()
  const widths = beat.panels.map((p) => p.box.x1 - p.box.x0)
  const heights = beat.panels.map((p) => p.box.y1 - p.box.y0)
  const sum = widths.reduce((a, b) => a + b, 0)
  const room = width - 2 * layout.marginX - layout.gap * (beat.panels.length - 1)
  const scale = Math.min(room / sum, layout.panelMaxH / Math.max(...heights))
  let x = (width - (sum * scale + layout.gap * (beat.panels.length - 1))) / 2
  const time = sourceAt(beat, t)
  return (
    <AbsoluteFill>
      <Ground />
      {beat.panels.map((panel, i) => {
        const left = x
        x += widths[i]! * scale + layout.gap
        return <PanelView key={i} panel={panel} time={time} scale={scale} left={left} layout={layout} />
      })}
    </AbsoluteFill>
  )
}

/** A label, then a rounded window holding the panel's crop of the recording at `time`. */
const PanelView: React.FC<{ panel: Panel; time: number; scale: number; left: number; layout: Layout }> = ({ panel, time, scale, left, layout }) => {
  const { fps } = useVideoConfig()
  const { box } = panel
  const w = (box.x1 - box.x0) * scale
  const h = (box.y1 - box.y0) * scale
  const accent = panel.accent === 'gold' ? C.gold : C.periwinkle
  const size = layout.labelSize
  return (
    <>
      <div style={{ position: 'absolute', left, top: layout.panelTop - size * 2.1, display: 'flex', alignItems: 'center', gap: size * 0.8 }}>
        <div style={{ width: size * 1.6, height: 2, borderRadius: 1, background: accent, opacity: 0.9 }} />
        <span style={{ font: `500 ${size}px/1 ${SANS}`, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.soft }}>{panel.label}</span>
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
          backgroundColor: C.ink,
          boxShadow: '0 40px 80px -44px rgba(0,0,0,0.95), 0 0 0 1px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: SOURCE.width,
            height: SOURCE.height,
            transformOrigin: '0 0',
            transform: `translate(${-box.x0 * scale}px, ${-box.y0 * scale}px) scale(${scale})`,
          }}
        >
          {/* Frozen at frame 0 and trimmed to `time`: a Freeze alone cannot reach past the cut's own length. */}
          <Freeze frame={0}>
            <OffthreadVideo src={staticFile(SOURCE.file)} trimBefore={time * fps} muted style={{ width: '100%', height: '100%', display: 'block' }} />
          </Freeze>
        </div>
        {/* An inner hairline, and light along the top edge in the panel's accent, as on the pages. */}
        <div style={{ position: 'absolute', inset: 0, borderRadius: layout.radius, boxShadow: `inset 0 0 0 1px ${white(0.08)}` }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, background: `linear-gradient(90deg, transparent 0%, ${accent} 30%, transparent 90%)`, opacity: 0.5 }} />
      </div>
    </>
  )
}

/** The step number in periwinkle and the caption in white with its gold keyword, on the films' caption panel. */
const StepCaption: React.FC<{ beat: Beat; enter: number; exit: number; layout: Layout }> = ({ beat, enter, exit, layout }) => {
  const opacity = enter * (1 - exit)
  if (opacity <= 0) return null
  const size = layout.captionSize
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: layout.captionY, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.62,
          transform: `translateY(-50%) translateY(${mix(enter, size * 0.3, 0) - size * 0.2 * exit}px)`,
          opacity,
          padding: `${size * 0.42}px ${size * 0.95}px ${size * 0.46}px ${size * 0.8}px`,
          borderRadius: size * 0.45,
          background: 'rgba(11, 12, 15, 0.80)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 24px 60px -28px rgba(0,0,0,0.9)',
        }}
      >
        <span style={{ font: `400 ${Math.round(size * 0.86)}px/1 ${SERIF}`, letterSpacing: '0.06em', color: C.periwinkle, fontVariantNumeric: 'lining-nums tabular-nums' }}>{beat.step}</span>
        <span style={{ width: 1, alignSelf: 'stretch', background: white(0.12) }} />
        <span style={{ font: `500 ${size}px/1.2 ${SANS}`, letterSpacing: '-0.003em', color: '#FFFFFF', whiteSpace: 'nowrap' }}>
          <RichText text={beat.caption} />
        </span>
      </div>
    </div>
  )
}
