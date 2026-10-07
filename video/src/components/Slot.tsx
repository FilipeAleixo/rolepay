import React from 'react'
import { AbsoluteFill, OffthreadVideo, getStaticFiles, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { SANS, SERIF } from '../fonts'
import { enter, progress } from '../motion'
import { C, gold, panel } from '../theme'
import { Ground } from './Ground'

export type SlotKind = 'camera' | 'screen'

/** True when the file is in video/assets/ (the public folder), so the clip can play. */
export const hasAsset = (file: string) => getStaticFiles().some((f) => f.name === file)

/**
 * A slot for one of the founder's recordings. When `file` is in video/assets/, the clip plays
 * (a camera clip fills the frame; a screen recording is fitted whole on the ink ground, and
 * plays silent). When it is missing, a neutral card says what goes here, so the timeline can be
 * reviewed before anything is recorded.
 */
export const Slot: React.FC<{ file: string; kind: SlotKind; label: string; note: string; plannedSeconds: number; index?: string }> = ({
  file,
  kind,
  label,
  note,
  plannedSeconds,
  index,
}) => {
  if (hasAsset(file)) {
    return (
      <AbsoluteFill style={{ backgroundColor: C.ink }}>
        <OffthreadVideo
          src={staticFile(file)}
          muted={kind === 'screen'}
          style={{ width: '100%', height: '100%', objectFit: kind === 'camera' ? 'cover' : 'contain' }}
        />
      </AbsoluteFill>
    )
  }
  return <MissingCard file={file} kind={kind} label={label} note={note} plannedSeconds={plannedSeconds} index={index} />
}

const MissingCard: React.FC<{ file: string; kind: SlotKind; label: string; note: string; plannedSeconds: number; index?: string }> = ({
  file,
  kind,
  label,
  note,
  plannedSeconds,
  index,
}) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const elapsed = progress(frame, 0, durationInFrames, (t) => t)
  return (
    <Ground>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            ...panel,
            ...enter(frame, 2, { duration: 16, distance: 10 }),
            width: 1240,
            padding: '56px 72px 60px',
            border: '1px dashed rgba(255,255,255,0.14)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ font: `600 20px/1 ${SANS}`, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.gold }}>
              {kind === 'camera' ? 'Camera' : 'Screen recording'}
              <span style={{ color: C.meta, fontWeight: 500 }}>{`  ·  ${label}`}</span>
            </span>
            {index ? <span style={{ font: `500 18px/1 ${SANS}`, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.meta }}>{index}</span> : null}
          </div>
          <div style={{ marginTop: 34, font: `400 46px/1.28 ${SERIF}`, color: C.head, letterSpacing: '-0.01em' }}>{note}</div>
          <div style={{ marginTop: 40, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 24 }}>
            <span style={{ font: '400 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace', color: C.soft }}>video/assets/{file}</span>
            <span style={{ font: `500 20px/1 ${SANS}`, color: C.meta, fontVariantNumeric: 'tabular-nums' }}>
              {(frame / fps).toFixed(1)} s of about {plannedSeconds} s
            </span>
          </div>
          <div style={{ marginTop: 18, height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.08)' }}>
            <div style={{ height: 2, borderRadius: 1, width: `${elapsed * 100}%`, background: gold(0.7) }} />
          </div>
        </div>
      </AbsoluteFill>
    </Ground>
  )
}
