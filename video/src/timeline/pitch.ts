import type { CaptionCue } from '../components/Caption'
import type { Item } from './Assembly'
import { PAYRUN_CAPTIONS, PAYRUN_SLOW_CAPTIONS } from './demo'

/**
 * The pitch (planned 2:08 silent, limit 3:00), framed around one line: a Safe keeps the money
 * safe; Rolepay works out who gets paid from what happened in Discord, and pays them all with one
 * approval, to people who need nothing but a passkey. The spending cap is not what is new (Safe's
 * spending-limit module has one); on Tempo it is part of the account. It works on camera, with the
 * voice alone, or with any mix of the two.
 *
 * It opens on one slide (the Overview scene: what Rolepay is, why it matters, who it is for, the
 * proof), narrated by pitch-1-problem, then the short demo, then straight into the trust model.
 *
 * Each slot plays the first of these that is in video/assets/:
 * - its recording (pitch-N-….mp4): a camera clip with its own sound and its overlays;
 * - for the screen slot, the demo film's pay-run take (demo-2-payrun.mp4) in its place;
 * - its voice-over alone (pitch-N-….m4a, .mp3 or .wav), over a voice card that shows what the
 *   camera overlay would (its points), as long as the speech;
 * - otherwise a card with what is said there.
 * A voice-over over a screen recording replaces the recording's sound. Each slot's `note` says what
 * it has to land, and its overlays or `card` hold the points shown on screen.
 *
 * The scenes read on their own, silent. A voice-over for one (in video/assets/, .m4a, .mp3 or
 * .wav) plays over it when it exists, and the scene lasts at least as long as the speech.
 */
/** The captions of `pitch-2-demo.mp4`, the slow cut of the first mainnet pay run (the demo film plays it too). */
const DEMO_CAPTIONS: CaptionCue[] = PAYRUN_SLOW_CAPTIONS

export const PITCH: Item[] = [
  // One slide: what it is, why it matters, who it is for, the proof. The voice-over is the opening's.
  { type: 'scene', scene: 'overview', voice: 'pitch-1-problem' },
  { type: 'scene', scene: 'trustModel', voice: 'pitch-vo-trust-model' },
  {
    type: 'slot',
    file: 'pitch-4-why-me.mp4',
    kind: 'camera',
    label: 'About me',
    note: 'About me: from Lisbon, a software engineer; DeFi protocols from 2021 to 2025 (Olympus DAO, Concave Finance, Fjord Foundry); founder of soulform.ai; two hackathon prizes in 2021.',
    seconds: 14,
    overlays: [
      {
        kind: 'points',
        title: 'About me',
        points: ['Software engineer, founder of *soulform.ai*, an AI startup', 'Building in crypto *since 2021*', 'Gitcoin, 2021: `discord-ethereum-authentication`', 'ETHOnline 2021, Enzyme Finance prize: `discord-dao-treasury-management`'],
        at: 1.5,
        until: 13.2,
      },
    ],
    voice: 'pitch-4-why-me',
    card: {
      kind: 'points',
      title: 'About me',
      photo: 'pitch-about-photo.jpg',
      links: ['github.com/FilipeAleixo', 'linkedin.com/in/faleixo'],
      points: [
        'Filipe Aleixo, software engineer, *Lisbon*',
        'DeFi, 2021 to 2025: *Olympus DAO*, *Concave Finance*, *Fjord Foundry*',
        'Founder of *soulform.ai*, an AI startup',
        'Gitcoin hackathon prize, 2021: `discord-ethereum-authentication`',
        'ETHOnline 2021, Enzyme Finance prize: `discord-dao-treasury-management`',
      ],
    },
  },
  {
    type: 'slot',
    file: 'pitch-5-business.mp4',
    kind: 'camera',
    label: 'Business',
    note: 'The business: an open-source core, and a hosted bot per community.',
    seconds: 10,
    overlays: [{ kind: 'points', title: 'The business', points: ['An *open-source* core', 'A *hosted bot* per community'], at: 1.5, until: 9.2 }],
    voice: 'pitch-5-business',
  },
  {
    type: 'slot',
    file: 'pitch-6-go-to-market.mp4',
    kind: 'camera',
    label: 'Go-to-market',
    note: 'Go-to-market: crypto communities first, then creators and gaming.',
    seconds: 9,
    overlays: [{ kind: 'points', title: 'Go-to-market', points: ['*Crypto communities* first', 'Then creator communities', 'Then gaming'], at: 1.2, until: 8.3 }],
    voice: 'pitch-6-go-to-market',
  },
  { type: 'scene', scene: 'endCard', voice: 'pitch-8-close' },
]
