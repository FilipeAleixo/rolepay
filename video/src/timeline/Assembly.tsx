import { parseMedia } from '@remotion/media-parser'
import { fade } from '@remotion/transitions/fade'
import { TransitionSeries, linearTiming } from '@remotion/transitions'
import React from 'react'
import { AbsoluteFill, Audio, type CalculateMetadataFunction, Sequence, getRemotionEnvironment, staticFile } from 'remotion'
import { type CaptionCue, Captions } from '../components/Caption'
import { LowerThird, SidePoints } from '../components/Overlays'
import { Slot, type SlotKind, hasAsset } from '../components/Slot'
import { VoiceCard, type VoiceCardContent } from '../components/VoiceCard'
import { SANS } from '../fonts'
import { SCENES, type SceneId } from '../scenes'
import { C, FPS, sec } from '../theme'
import { speechSpan } from './speech'

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
  /** What is shown or said here, printed on the card until the file exists. */
  note: string
  /** The planned length. When the file exists, its real length is used instead. */
  seconds: number
  captions?: CaptionCue[]
  overlays?: Overlay[]
  /** A screen recording plays silent unless this is set (for one narrated while recording). */
  audible?: boolean
  /**
   * An optional voice-over for the slot: a base name in video/assets/ (".m4a", ".mp3" or ".wav").
   * With no recording, it plays over a voice card (`card`) and the slot is as long as the speech.
   * Over a screen recording it replaces the recording's own sound, and a longer one holds the
   * recording's last frame until it ends. A camera clip keeps its own sound, so there it is unused.
   * The silence recorded at either end of the file is left out (`speech.ts`).
   */
  voice?: string
  /** What the voice card shows. Without it, the slot's points overlay is used. */
  card?: VoiceCardContent
  /** A recording to play when `file` is missing, with the captions timed to that recording. */
  fallback?: { file: string; captions?: CaptionCue[] }
}
export type SceneItem = {
  type: 'scene'
  scene: SceneId
  /**
   * An optional voice-over for the scene: a base name in video/assets/ (".m4a", ".mp3" or ".wav").
   * When it exists it plays over the scene, and a longer one holds the scene's last state for it.
   * As for a slot's, the silence recorded at either end of the file is left out.
   */
  voice?: string
}
export type Item = SlotItem | SceneItem

/** The speech of a voice-over file, in frames of the file: the silence recorded around it is left out. */
export type VoiceTake = { file: string; from: number; to: number }

/** One item as the real files make it: its length, its voice-over and the length of the recording it plays. */
export type ItemFit = { frames: number; voice: VoiceTake | null; clipFrames: number | null }

export type AssemblyProps = {
  items: Item[]
  /** Per item, filled in by `fitTimeline` from the real clips and voice-overs. */
  fit: ItemFit[] | null
  /** Optional sound bed: a file in video/assets/. Nothing plays while it is missing. */
  audio: string | null
  audioVolume: number
  /** The submission's hard limit: the studio shows a warning past it. */
  maxSeconds: number
}

const planned = (item: Item) => (item.type === 'scene' ? SCENES[item.scene].frames : sec(item.seconds))

export const totalFrames = (frames: number[]) => frames.reduce((a, b) => a + b, 0) - TRANSITION_FRAMES * Math.max(0, frames.length - 1)

const VOICE_EXTENSIONS = ['.m4a', '.mp3', '.wav'] as const

/** The voice-over file for a scene or a slot, if one of its extensions is in video/assets/. */
export const voiceFile = (base: string | undefined) => (base ? (VOICE_EXTENSIONS.map((e) => base + e).find(hasAsset) ?? null) : null)

/** The speech starts this far into its item, after the crossfade, and the item runs this long past it. */
const VOICE_LEAD = sec(0.2)
const VOICE_TAIL = sec(0.6)

/** How long an item must be to carry a voice-over. */
const spoken = (v: VoiceTake) => VOICE_LEAD + (v.to - v.from) + VOICE_TAIL

/**
 * What a slot plays: its own recording, else its fallback; the captions timed to that recording;
 * and its voice-over, over a screen recording or in place of a missing one (a camera clip keeps
 * its own sound).
 */
export const slotPlan = (item: SlotItem) => {
  const clip = hasAsset(item.file) ? item.file : item.fallback && hasAsset(item.fallback.file) ? item.fallback.file : null
  const captions = clip === item.file ? item.captions : clip ? item.fallback?.captions : undefined
  const voice = clip && item.kind === 'camera' ? null : voiceFile(item.voice)
  return { clip, captions, voice }
}

/** What a voice card shows: the slot's own card, else its points overlay. */
const cardOf = (item: SlotItem): VoiceCardContent | null => {
  if (item.card) return item.card
  const o = item.overlays?.find((x) => x.kind === 'points')
  return o?.kind === 'points' ? { kind: 'points', title: o.title, points: o.points } : null
}

/** A media file's length in frames, or null when it cannot be read. */
async function mediaFrames(file: string): Promise<number | null> {
  try {
    const { durationInSeconds } = await parseMedia({ src: staticFile(file), fields: { durationInSeconds: true }, acknowledgeRemotionLicense: true })
    return durationInSeconds ? Math.floor(durationInSeconds * FPS) : null
  } catch {
    return null
  }
}

/** The speech in a voice-over file, or the whole file when it cannot be decoded. */
async function voiceTake(file: string): Promise<VoiceTake | null> {
  const span = await speechSpan(staticFile(file))
  if (span && span.to > span.from) return { file, from: Math.floor(span.from * FPS), to: Math.ceil(span.to * FPS) }
  const frames = await mediaFrames(file)
  return frames === null ? null : { file, from: 0, to: frames }
}

/**
 * A slot is as long as the clip dropped into it, or as its voice-over when there is no clip (or a
 * longer one over a screen recording); a scene is at least as long as its voice-over.
 */
async function fitItem(item: Item): Promise<ItemFit> {
  if (item.type === 'scene') {
    const file = voiceFile(item.voice)
    const voice = file ? await voiceTake(file) : null
    return { frames: Math.max(planned(item), voice ? spoken(voice) : 0), voice, clipFrames: null }
  }
  const plan = slotPlan(item)
  const voice = plan.voice ? await voiceTake(plan.voice) : null
  const clipFrames = plan.clip ? await mediaFrames(plan.clip) : null
  const shortest = TRANSITION_FRAMES * 2 + 1
  if (plan.clip) return { frames: Math.max(shortest, clipFrames ?? sec(item.seconds), voice ? spoken(voice) : 0), voice, clipFrames }
  return { frames: voice ? Math.max(shortest, spoken(voice)) : sec(item.seconds), voice, clipFrames: null }
}

export const fitTimeline: CalculateMetadataFunction<AssemblyProps> = async ({ props }) => {
  const fit = await Promise.all(props.items.map(fitItem))
  return { durationInFrames: totalFrames(fit.map((f) => f.frames)), props: { ...props, fit } }
}

/** The planned length of a timeline before any clip exists (Root uses it as the default). */
export const plannedFrames = (items: Item[]) => totalFrames(items.map(planned))

export const Assembly: React.FC<AssemblyProps> = ({ items, fit, audio, audioVolume, maxSeconds }) => {
  const lengths = fit?.map((f) => f.frames) ?? items.map(planned)
  const slots = items.filter((i) => i.type === 'slot').length
  let slotNumber = 0
  const children: React.ReactNode[] = []
  items.forEach((item, i) => {
    if (i > 0) children.push(<TransitionSeries.Transition key={`t${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />)
    if (item.type === 'slot') slotNumber += 1
    children.push(
      <TransitionSeries.Sequence key={`s${i}`} durationInFrames={lengths[i] ?? planned(item)} name={item.type === 'scene' ? SCENES[item.scene].id : `${item.kind}: ${item.label}`}>
        {item.type === 'scene' ? (
          <SceneView id={item.scene} voice={item.voice} take={fit?.[i]?.voice ?? null} />
        ) : (
          <SlotView item={item} index={`Slot ${slotNumber} of ${slots}`} fit={fit?.[i] ?? null} />
        )}
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

/** A voice-over: its speech only, starting just after the crossfade (the whole file before the timeline is fitted). */
const VoiceTrack: React.FC<{ file: string; take: VoiceTake | null }> = ({ file, take }) =>
  take && take.file === file ? (
    <Sequence from={VOICE_LEAD} layout="none" name={`voice: ${file}`}>
      <Audio src={staticFile(file)} trimBefore={take.from} durationInFrames={take.to - take.from} />
    </Sequence>
  ) : (
    <Audio src={staticFile(file)} />
  )

const SceneView: React.FC<{ id: SceneId; voice?: string; take: VoiceTake | null }> = ({ id, voice, take }) => {
  const Component = SCENES[id].component
  const file = voiceFile(voice)
  return (
    <AbsoluteFill>
      <Component />
      {file ? <VoiceTrack file={file} take={take} /> : null}
    </AbsoluteFill>
  )
}

/**
 * A slot: its recording with its overlays and captions; or, with only a voice-over, the voice card;
 * or the card that says what goes here.
 */
const SlotView: React.FC<{ item: SlotItem; index: string; fit: ItemFit | null }> = ({ item, index, fit }) => {
  const { clip, captions, voice } = slotPlan(item)
  const card = cardOf(item)
  if (!clip && voice && card) {
    return (
      <AbsoluteFill>
        <VoiceCard content={card} />
        <VoiceTrack file={voice} take={fit?.voice ?? null} />
      </AbsoluteFill>
    )
  }
  return (
    <AbsoluteFill>
      <Slot
        file={clip ?? item.file}
        kind={item.kind}
        label={item.label}
        note={item.note}
        plannedSeconds={item.seconds}
        index={index}
        audible={(item.audible ?? false) && !voice}
        clipFrames={fit?.clipFrames ?? null}
        voice={item.voice}
      />
      {item.overlays?.map((o, i) =>
        o.kind === 'lowerThird' ? (
          <LowerThird key={i} from={sec(o.at)} to={sec(o.until)} />
        ) : (
          <SidePoints key={i} title={o.title} points={o.points} from={sec(o.at)} to={sec(o.until)} />
        ),
      )}
      {captions ? <Captions cues={captions} /> : null}
      {voice ? <VoiceTrack file={voice} take={fit?.voice ?? null} /> : null}
    </AbsoluteFill>
  )
}

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
