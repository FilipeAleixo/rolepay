import type { CutProps } from './Cut'

/**
 * Two cuts of the first mainnet pay run (video/assets/mainnet-run.mov), the same four beats at the
 * recording's own pace (footage.ts): a run sent from Discord; the treasurer's approval with the
 * payee's balance arriving beside it; the DM receipt; the transaction on the explorer. A title card
 * before them and an end card after.
 *
 * ReadmeLoop (1400 by 730 at 24 fps, silent, loops): the master for the README GIF, which takes
 * every other frame (12 fps, 128 colours, about 5 MB). `npm run render:readme`, then
 * `npm run gif:readme` (ffmpeg) for out/readme-loop.gif.
 * XClip (1920 by 1080 at 30 fps, a silent audio track for X): `npm run render:x`. Chrome now and
 * then captures one frame of it tiled (the top-left of the page repeated); play the render
 * through once, and if a frame jumps, render it again, or render it with `--sequence` and encode
 * the frames with ffmpeg.
 *
 * Both layouts give two side-by-side panels the same shape (1.343), so every beat frames the same
 * thing in both cuts.
 */
export const README_FPS = 24
export const README_SIZE = { width: 1400, height: 730 } as const

const BEAT_ORDER: CutProps['beats'] = ['send', 'approve', 'receipt', 'explorer']

export const README_LOOP: CutProps = {
  layout: {
    marginX: 32,
    gap: 24,
    panelTop: 58,
    panelH: 488,
    radius: 14,
    labelSize: 13,
    headlineY: 598,
    headlineSize: 29,
    sublineY: 638,
    sublineSize: 18.5,
    progressY: 688,
    unit: 1400 / 1920,
  },
  beats: BEAT_ORDER,
  fade: 0.4,
  loop: true,
  title: 2.2,
  end: 2.4,
  endPromise: false,
}

export const X_CLIP: CutProps = {
  layout: {
    marginX: 44,
    gap: 32,
    panelTop: 92,
    panelH: 670,
    radius: 18,
    labelSize: 18,
    headlineY: 838,
    headlineSize: 46,
    sublineY: 898,
    sublineSize: 29,
    progressY: 966,
    unit: 1,
  },
  beats: BEAT_ORDER,
  fade: 0.4,
  loop: false,
  title: 2.2,
  end: 3.2,
  endPromise: true,
}
