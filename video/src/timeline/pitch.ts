import type { CaptionCue } from '../components/Caption'
import type { Item } from './Assembly'
import { PAYRUN_CAPTIONS } from './demo'

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
const DEMO_CAPTIONS: CaptionCue[] = [
  { at: 0.5, until: 4.5, text: '`/rolepay new` builds a run for a *role*' },
  { at: 5, until: 8.5, text: 'One tap to *approve*, one batched transaction' },
  { at: 9, until: 12.5, text: 'Every payee gets a *DM receipt*' },
]

export const PITCH: Item[] = [
  // One slide: what it is, why it matters, who it is for, the proof. The voice-over is the opening's.
  { type: 'scene', scene: 'overview', voice: 'pitch-1-problem' },
  {
    type: 'slot',
    file: 'pitch-2-demo.mp4',
    kind: 'screen',
    label: 'The demo, short',
    note: 'A short cut of the demo, about 13 s: a pay run approved in Discord, paid in one transaction, the DM receipt.',
    seconds: 13,
    audible: true,
    captions: DEMO_CAPTIONS,
    voice: 'pitch-2-demo',
    fallback: { file: 'demo-2-payrun.mp4', captions: PAYRUN_CAPTIONS },
    card: { kind: 'points', title: 'A pay run, from Discord', points: DEMO_CAPTIONS.map((c) => c.text) },
  },
  { type: 'scene', scene: 'trustModel', voice: 'pitch-vo-trust-model' },
  { type: 'scene', scene: 'ownBudgets', voice: 'pitch-vo-own-budgets' },
  { type: 'scene', scene: 'whyTempo', voice: 'pitch-vo-why-tempo' },
  {
    type: 'slot',
    file: 'pitch-4-why-me.mp4',
    kind: 'camera',
    label: 'Why me',
    note: 'Why me: two hackathon wins in 2021, both about Discord and on-chain money.',
    seconds: 12,
    overlays: [
      {
        kind: 'points',
        title: 'Hackathon wins, 2021',
        points: ['Gitcoin: `discord-ethereum-authentication`', 'ETHOnline, Enzyme, 2nd place: `discord-dao-treasury-management`'],
        at: 1.5,
        until: 11.2,
      },
    ],
    voice: 'pitch-4-why-me',
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
  { type: 'scene', scene: 'architecture', voice: 'pitch-vo-architecture' },
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
  {
    type: 'slot',
    file: 'pitch-7-status.mp4',
    kind: 'camera',
    label: 'Honest status',
    note: 'Honest status: what works today, what was proven on chain, what is not done yet.',
    seconds: 12,
    voice: 'pitch-7-status',
    card: {
      kind: 'points',
      title: 'Where it stands',
      points: ['The *testnet demo* runs all of it, open to try', 'A first real pay run on *Tempo mainnet*, 8 October', '*Still open:* a second RPC, the setup page on its own origin, a separate signer'],
    },
  },
  { type: 'scene', scene: 'numbers', voice: 'pitch-vo-numbers' },
  { type: 'scene', scene: 'endCard' },
]
