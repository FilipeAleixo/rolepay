import type { CaptionCue } from '../components/Caption'
import type { Item } from './Assembly'
import { PAYRUN_CAPTIONS } from './demo'

/**
 * The pitch (planned 2:33, limit 3:00), framed around one line: access keys are how you give
 * software a budget it can't exceed, and Rolepay gives one to a community's bot and one to each
 * of its standing policies. It works on camera, with the voice alone, or with any mix of the two.
 *
 * Each slot plays the first of these that is in video/assets/:
 * - its recording (pitch-N-….mp4): a camera clip with its own sound and its overlays;
 * - for the screen slot, the demo film's pay-run take (demo-2-payrun.mp4) in its place;
 * - its voice-over alone (pitch-N-….m4a, .mp3 or .wav), over a voice card that shows what the
 *   camera overlay would (the frame line and the name, or the points), as long as the speech;
 * - otherwise a card with what is said there.
 * A voice-over over a screen recording replaces the recording's sound. SCRIPT.md has the talking
 * points for every slot.
 *
 * The scenes read on their own, silent. A voice-over for one (pitch-vo-*.m4a, .mp3 or .wav in
 * video/assets/) plays over it when it exists, so the presenter's voice can carry through.
 */
const DEMO_CAPTIONS: CaptionCue[] = [
  { at: 0.5, until: 5.5, text: '`/rolepay new` builds a run for a *role*' },
  { at: 6, until: 10.5, text: 'One tap to *approve*, one batched transaction' },
  { at: 11, until: 15.5, text: 'Every payee gets a *DM receipt*' },
]

export const PITCH: Item[] = [
  { type: 'scene', scene: 'title' },
  {
    type: 'slot',
    file: 'pitch-1-problem.mp4',
    kind: 'camera',
    label: 'The opening and the problem',
    note: "Open on access keys: a budget software can't exceed. Then the problem, in one community's words.",
    seconds: 15,
    overlays: [{ kind: 'lowerThird', at: 0.8, until: 5.6 }],
    voice: 'pitch-1-problem',
    card: { kind: 'opening', line: "Access keys are how you give software *a budget it can't exceed.*", portrait: 'pitch-1-portrait' },
  },
  { type: 'scene', scene: 'problem', voice: 'pitch-vo-problem' },
  {
    type: 'slot',
    file: 'pitch-2-demo.mp4',
    kind: 'screen',
    label: 'The demo, short',
    note: 'A short cut of the demo: a pay run approved in Discord, paid in one transaction, the DM receipt.',
    seconds: 16,
    audible: true,
    captions: DEMO_CAPTIONS,
    voice: 'pitch-2-demo',
    fallback: { file: 'demo-2-payrun.mp4', captions: PAYRUN_CAPTIONS },
    card: { kind: 'points', title: 'A pay run, from Discord', points: DEMO_CAPTIONS.map((c) => c.text) },
  },
  {
    type: 'slot',
    file: 'pitch-3-why-tempo.mp4',
    kind: 'camera',
    label: 'Why Tempo',
    note: 'Why Tempo: access keys. The bot never holds the money, and the chain caps what each key can spend.',
    seconds: 9,
    overlays: [
      {
        kind: 'points',
        title: 'Access keys',
        points: ["A budget software *can't exceed*", 'One for the *bot*, one for each *policy*', "Authorised by the treasurer's *passkey*"],
        at: 1.5,
        until: 8.4,
      },
    ],
    voice: 'pitch-3-why-tempo',
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
