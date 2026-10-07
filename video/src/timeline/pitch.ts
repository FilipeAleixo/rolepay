import type { Item } from './Assembly'

/**
 * The pitch (target 2:30): the founder on camera, with the scenes cut in, in the order of the
 * outline. Each camera clip goes in video/assets/ under its file name; until it exists its slot
 * shows a card with what is said there. SCRIPT.md has the talking points for every slot.
 */
export const PITCH: Item[] = [
  { type: 'scene', scene: 'title' },
  {
    type: 'slot',
    file: 'pitch-1-problem.mp4',
    kind: 'camera',
    label: 'The problem',
    note: "The problem, in one community's words: who gets paid each month, and how it is done today.",
    seconds: 17,
    overlays: [{ kind: 'lowerThird', at: 0.8, until: 5.6 }],
  },
  { type: 'scene', scene: 'problem' },
  {
    type: 'slot',
    file: 'pitch-2-demo.mp4',
    kind: 'screen',
    label: 'The demo, short',
    note: 'A short cut of the demo: a pay run approved in Discord, paid in one transaction, the DM receipt.',
    seconds: 20,
    captions: [
      { at: 0.5, until: 6.5, text: '`/rolepay new` builds a run for a *role*' },
      { at: 7, until: 13, text: 'One tap to *approve*, one batched transaction' },
      { at: 13.5, until: 19.5, text: 'Every payee gets a *DM receipt*' },
    ],
  },
  {
    type: 'slot',
    file: 'pitch-3-why-tempo.mp4',
    kind: 'camera',
    label: 'Why Tempo',
    note: 'Why Tempo: the bot never holds the money, and the chain enforces what it can spend.',
    seconds: 8,
  },
  { type: 'scene', scene: 'trustModel' },
  { type: 'scene', scene: 'whyTempo' },
  {
    type: 'slot',
    file: 'pitch-4-why-me.mp4',
    kind: 'camera',
    label: 'Why me',
    note: 'Why you: two hackathon wins in 2021, both about Discord and on-chain money.',
    seconds: 14,
    overlays: [
      {
        kind: 'points',
        title: 'Hackathon wins, 2021',
        points: ['Gitcoin: `discord-ethereum-authentication`', 'ETHOnline, Enzyme, 2nd place: `discord-dao-treasury-management`'],
        at: 2,
        until: 13.2,
      },
    ],
  },
  {
    type: 'slot',
    file: 'pitch-5-business.mp4',
    kind: 'camera',
    label: 'Business',
    note: 'The business: an open-source core, and a hosted bot per community.',
    seconds: 12,
    overlays: [{ kind: 'points', title: 'The business', points: ['An *open-source* core', 'A *hosted bot* per community'], at: 2, until: 11.2 }],
  },
  { type: 'scene', scene: 'architecture' },
  {
    type: 'slot',
    file: 'pitch-6-go-to-market.mp4',
    kind: 'camera',
    label: 'Go-to-market',
    note: 'Go-to-market: crypto communities first, then creators and gaming.',
    seconds: 10,
    overlays: [{ kind: 'points', title: 'Go-to-market', points: ['*Crypto communities* first', 'Then creator communities', 'Then gaming'], at: 1.5, until: 9.3 }],
  },
  {
    type: 'slot',
    file: 'pitch-7-status.mp4',
    kind: 'camera',
    label: 'Honest status',
    note: 'Honest status: what works today, what was proven on chain, what is not done yet.',
    seconds: 13,
  },
  { type: 'scene', scene: 'numbers' },
  { type: 'scene', scene: 'endCard' },
]
