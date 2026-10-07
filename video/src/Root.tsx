import React from 'react'
import { Composition, Folder } from 'remotion'
import { CaptionPreview } from './components/Caption'
import { LowerThirdPreview } from './components/Overlays'
import './fonts'
import { SCENES } from './scenes'
import { Assembly, type AssemblyProps, fitTimeline, plannedFrames } from './timeline/Assembly'
import { DEMO } from './timeline/demo'
import { PITCH } from './timeline/pitch'
import { FPS, HEIGHT, WIDTH, sec } from './theme'

const frame = { fps: FPS, width: WIDTH, height: HEIGHT } as const

const pitchProps: AssemblyProps = { items: PITCH, frames: null, audio: 'pitch-audio.mp3', audioVolume: 0.12, maxSeconds: 180 }
const demoProps: AssemblyProps = { items: DEMO, frames: null, audio: 'demo-audio.mp3', audioVolume: 0.12, maxSeconds: 180 }

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="Films">
      <Composition id="PitchVideo" component={Assembly} durationInFrames={plannedFrames(PITCH)} defaultProps={pitchProps} calculateMetadata={fitTimeline} {...frame} />
      <Composition id="DemoVideo" component={Assembly} durationInFrames={plannedFrames(DEMO)} defaultProps={demoProps} calculateMetadata={fitTimeline} {...frame} />
    </Folder>
    <Folder name="Scenes">
      {Object.values(SCENES).map((s) => (
        <Composition key={s.id} id={s.id} component={s.component} durationInFrames={s.frames} {...frame} />
      ))}
    </Folder>
    <Folder name="Overlays">
      <Composition id="Captions" component={CaptionPreview} durationInFrames={sec(8)} {...frame} />
      <Composition id="LowerThird" component={LowerThirdPreview} durationInFrames={sec(6)} {...frame} />
    </Folder>
  </>
)
