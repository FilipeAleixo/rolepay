import type { CutProps } from './Cut'

/**
 * Two cuts of the first mainnet pay run (video/assets/mainnet-run.mov), the same four beats at the
 * recording's own pace (footage.ts): the run sent from Discord; the Treasurer's approval with the
 * payee's balance arriving beside it; the DM receipt; the transaction on the explorer.
 *
 * ReadmeLoop (1400 by 820 at 24 fps, silent, loops): the master for the README GIF, which takes
 * every other frame (12 fps). `npm run render:readme`, then `npm run gif:readme` (ffmpeg) for
 * out/readme-loop.gif.
 * XClip (1920 by 1080 at 30 fps, a silent audio track for X): the same beats with a short title
 * before and the end card after. `npm run render:x`.
 */
export const README_FPS = 24
export const README_SIZE = { width: 1400, height: 820 } as const

const BEAT_ORDER: CutProps['beats'] = ['send', 'approve', 'receipt', 'explorer']

export const README_LOOP: CutProps = {
  layout: { marginX: 24, gap: 20, panelTop: 60, panelMaxH: 660, radius: 14, labelSize: 15, captionY: 770, captionSize: 28 },
  beats: BEAT_ORDER,
  fade: 0.4,
  loop: true,
  title: 0,
  end: 0,
}

export const X_CLIP: CutProps = {
  layout: { marginX: 48, gap: 28, panelTop: 82, panelMaxH: 862, radius: 18, labelSize: 19, captionY: 1010, captionSize: 38 },
  beats: BEAT_ORDER,
  fade: 0.4,
  loop: false,
  title: 1.5,
  end: 3.0,
}
