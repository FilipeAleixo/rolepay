import { parseMedia } from '@remotion/media-parser'
import { fade } from '@remotion/transitions/fade'
import { TransitionSeries, linearTiming } from '@remotion/transitions'
import React from 'react'
import { AbsoluteFill, Audio, type CalculateMetadataFunction, getRemotionEnvironment, staticFile } from 'remotion'
import { type CaptionCue, Captions } from '../components/Caption'
import { LowerThird, SidePoints } from '../components/Overlays'
import { Slot, type SlotKind, hasAsset } from '../components/Slot'
import { SANS } from '../fonts'
import { SCENES, type SceneId } from '../scenes'
import { C, FPS, sec } from '../theme'

/** A crossfade between every two items: short, so cuts stay calm without eating the timeline. */
export const TRANSITION_FRAMES = 10

export type Overlay =
  | { kind: 'lowerThird'; at: number; until: number }
  | { kind: 'points'; title: string; points: string[]; at: number; until: number }

export type SlotItem = {
  type: 'slot'
  /** The file in video/assets/, for example "demo-2-payrun.mp4". */
  file: string
  kind: SlotKind
  /** A short name for the slot (the studio's timeline and the missing-file card). */
  label: string
  /** What the founder shows or says here, printed on the card until the file exists. */
  note: string
  /** The planned length. When the file exists, its real length is used instead. */
  seconds: number
  captions?: CaptionCue[]
  overlays?: Overlay[]
  /** A screen recording plays silent unless this is set (for one narrated while recording). */
  audible?: boolean
}
export type SceneItem = {
  type: 'scene'
  scene: SceneId
  /**
   * An optional voice-over for the scene: a base name in video/assets/ (".m4a", ".mp3" or ".wav").
   * When it exists it plays over the scene, and a longer one holds the scene's last state for it.
   */
  voice?: string
}
export type Item = SlotItem | SceneItem

export type AssemblyProps = {
  items: Item[]
  /** Frames per item, filled in by `fitTimeline` from the real clips. */
  frames: number[] | null
  /** Optional sound bed: a file in video/assets/. Nothing plays while it is missing. */
  audio: string | null
  audioVolume: number
  /** The submission's hard limit: the studio shows a warning past it. */
  maxSeconds: number
}

const planned = (item: Item) => (item.type === 'scene' ? SCENES[item.scene].frames : sec(item.seconds))

export const totalFrames = (frames: number[]) => frames.reduce((a, b) => a + b, 0) - TRANSITION_FRAMES * Math.max(0, frames.length - 1)

const VOICE_EXTENSIONS = ['.m4a', '.mp3', '.wav'] as const

/** The voice-over file for a scene, if one of its extensions is in video/assets/. */
export const voiceFile = (base: string | undefined) => (base ? (VOICE_EXTENSIONS.map((e) => base + e).find(hasAsset) ?? null) : null)

/** A media file's length in frames, or null when it cannot be read. */
async function mediaFrames(file: string): Promise<number | null> {
  try {
    const { durationInSeconds } = await parseMedia({ src: staticFile(file), fields: { durationInSeconds: true }, acknowledgeRemotionLicense: true })
    return durationInSeconds ? Math.floor(durationInSeconds * FPS) : null
  } catch {
    return null
  }
}

/** A slot is as long as the clip dropped into it; a scene is at least as long as its voice-over. */
async function itemFrames(item: Item): Promise<number> {
  if (item.type === 'scene') {
    const voice = voiceFile(item.voice)
    const spoken = voice ? await mediaFrames(voice) : null
    return Math.max(planned(item), spoken === null ? 0 : spoken + sec(0.6))
  }
  if (!hasAsset(item.file)) return sec(item.seconds)
  const clip = await mediaFrames(item.file)
  return clip === null ? sec(item.seconds) : Math.max(TRANSITION_FRAMES * 2 + 1, clip)
}

export const fitTimeline: CalculateMetadataFunction<AssemblyProps> = async ({ props }) => {
  const frames = await Promise.all(props.items.map(itemFrames))
  return { durationInFrames: totalFrames(frames), props: { ...props, frames } }
}

/** The planned length of a timeline before any clip exists (Root uses it as the default). */
export const plannedFrames = (items: Item[]) => totalFrames(items.map(planned))

export const Assembly: React.FC<AssemblyProps> = ({ items, frames, audio, audioVolume, maxSeconds }) => {
  const lengths = frames ?? items.map(planned)
  const slots = items.filter((i) => i.type === 'slot').length
  let slotNumber = 0
  const children: React.ReactNode[] = []
  items.forEach((item, i) => {
    if (i > 0) children.push(<TransitionSeries.Transition key={`t${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />)
    if (item.type === 'slot') slotNumber += 1
    children.push(
      <TransitionSeries.Sequence key={`s${i}`} durationInFrames={lengths[i] ?? planned(item)} name={item.type === 'scene' ? SCENES[item.scene].id : `${item.kind}: ${item.label}`}>
        {item.type === 'scene' ? <SceneView id={item.scene} voice={item.voice} /> : <SlotView item={item} index={`Slot ${slotNumber} of ${slots}`} />}
      </TransitionSeries.Sequence>,
    )
  })
  return (
    <AbsoluteFill style={{ backgroundColor: C.ink }}>
      <TransitionSeries>{children}</TransitionSeries>
      {audio && hasAsset(audio) ? <Audio src={staticFile(audio)} volume={audioVolume} /> : null}
      <LengthWarning frames={totalFrames(lengths)} maxSeconds={maxSeconds} />
    </AbsoluteFill>
  )
}

const SceneView: React.FC<{ id: SceneId; voice?: string }> = ({ id, voice }) => {
  const Component = SCENES[id].component
  const file = voiceFile(voice)
  return (
    <AbsoluteFill>
      <Component />
      {file ? <Audio src={staticFile(file)} /> : null}
    </AbsoluteFill>
  )
}

const SlotView: React.FC<{ item: SlotItem; index: string }> = ({ item, index }) => (
  <AbsoluteFill>
    <Slot file={item.file} kind={item.kind} label={item.label} note={item.note} plannedSeconds={item.seconds} index={index} audible={item.audible ?? false} />
    {item.overlays?.map((o, i) =>
      o.kind === 'lowerThird' ? (
        <LowerThird key={i} from={sec(o.at)} to={sec(o.until)} />
      ) : (
        <SidePoints key={i} title={o.title} points={o.points} from={sec(o.at)} to={sec(o.until)} />
      ),
    )}
    {item.captions ? <Captions cues={item.captions} /> : null}
  </AbsoluteFill>
)

/** In the studio only: says when the clips have pushed the film past the submission's limit. */
const LengthWarning: React.FC<{ frames: number; maxSeconds: number }> = ({ frames, maxSeconds }) => {
  if (!getRemotionEnvironment().isStudio || frames <= sec(maxSeconds)) return null
  const over = (frames / FPS - maxSeconds).toFixed(1)
  return (
    <div
      style={{
        position: 'absolute',
        right: 24,
        top: 24,
        padding: '10px 16px',
        borderRadius: 10,
        background: 'rgba(224,142,146,0.16)',
        boxShadow: 'inset 0 0 0 1px rgba(224,142,146,0.5)',
        font: `600 20px/1 ${SANS}`,
        color: '#E08E92',
      }}
    >
      {over} s over the {maxSeconds} s limit (studio only)
    </div>
  )
}
