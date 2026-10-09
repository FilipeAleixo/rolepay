import React from 'react'
import { Composition, Folder } from 'remotion'
import { CaptionPreview } from './components/Caption'
import { LowerThirdPreview } from './components/Overlays'
import { README_FPS, README_LOOP, README_SIZE, X_CLIP } from './cuts'
import { Cut, cutFrames } from './cuts/Cut'
import './fonts'
import { SCENES } from './scenes'
import { Assembly, type AssemblyProps, PrompterFilm, fitPrompter, fitTimeline, plannedFrames } from './timeline/Assembly'
import { DEMO } from './timeline/demo'
import { PITCH } from './timeline/pitch'
import { PROMPTER_INTRO_FRAMES, PROMPTER_LINES } from './timeline/prompter'
import { FPS, HEIGHT, WIDTH, sec } from './theme'

const frame = { fps: FPS, width: WIDTH, height: HEIGHT } as const

const pitchProps: AssemblyProps = { items: PITCH, fit: null, audio: 'pitch-audio.mp3', audioVolume: 0.12, maxSeconds: 180 }
const demoProps: AssemblyProps = { items: DEMO, fit: null, audio: 'demo-audio.mp3', audioVolume: 0.12, maxSeconds: 180 }

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="Films">
      <Composition id="PitchVideo" component={Assembly} durationInFrames={plannedFrames(PITCH)} defaultProps={pitchProps} calculateMetadata={fitTimeline} {...frame} />
      <Composition id="DemoVideo" component={Assembly} durationInFrames={plannedFrames(DEMO)} defaultProps={demoProps} calculateMetadata={fitTimeline} {...frame} />
      <Composition
        id="PitchPrompter"
        component={PrompterFilm}
        durationInFrames={plannedFrames(PITCH) + PROMPTER_INTRO_FRAMES}
        defaultProps={{ ...pitchProps, audio: null, prompter: PROMPTER_LINES }}
        calculateMetadata={fitPrompter}
        {...frame}
      />
    </Folder>
    <Folder name="Scenes">
      {Object.values(SCENES).map((s) => (
        <Composition key={s.id} id={s.id} component={s.component} durationInFrames={s.frames} {...frame} />
      ))}
    </Folder>
    <Folder name="Cuts">
      <Composition id="ReadmeLoop" component={Cut} durationInFrames={cutFrames(README_LOOP, README_FPS)} defaultProps={README_LOOP} fps={README_FPS} {...README_SIZE} />
      <Composition id="XClip" component={Cut} durationInFrames={cutFrames(X_CLIP, FPS)} defaultProps={X_CLIP} {...frame} />
    </Folder>
    <Folder name="Overlays">
      <Composition id="Captions" component={CaptionPreview} durationInFrames={sec(8)} {...frame} />
      <Composition id="LowerThird" component={LowerThirdPreview} durationInFrames={sec(6)} {...frame} />
    </Folder>
  </>
)
