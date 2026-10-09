import type { CaptionCue } from '../components/Caption'
import type { Item } from './Assembly'

/** The captions of `demo-2-payrun.mp4`, the fast cut of the first mainnet pay run (the fallback when the slow cut is missing). */
export const PAYRUN_CAPTIONS: CaptionCue[] = [
  { at: 0.5, until: 3, text: '`/rolepay new` builds a run' },
  { at: 3.4, until: 8.5, text: 'A Treasurer approves in *#treasury*, and the money lands' },
  { at: 8.8, until: 12.8, text: 'A *receipt* by DM, and the transaction on *Tempo mainnet*' },
]

/** The captions of `pitch-2-demo.mp4`, the slow cut of the first mainnet pay run, one per beat (the demo and the pitch both play it). */
export const PAYRUN_SLOW_CAPTIONS: CaptionCue[] = [
  { at: 0.4, until: 6.6, text: '`/rolepay new` builds a run' },
  { at: 7.4, until: 15.6, text: 'A Treasurer approves in *#treasury*, and the money lands' },
  { at: 16.4, until: 24.4, text: 'A *receipt* by DM, and the transaction on *Tempo mainnet*' },
]

/**
 * The demo (hard limit 3:00): the overview slide's four lines, then one screen recording of the
 * live product for each, with captions, and a slide naming what else is built. Captions are timed
 * in seconds from the start of their clip; each slot's `note` says what its recording shows.
 */
export const DEMO: Item[] = [
  // The four lines the recordings then show, one each.
  { type: 'scene', scene: 'overview' },
  // The community's own account and a capped bot key: what every run below stands on.
  {
    type: 'slot',
    file: 'demo-1-setup.mp4',
    kind: 'screen',
    label: 'Setup and the treasury passkey',
    note: 'Rolepay added to a server, /rolepay setup and its card, then the setup page: the treasury created with a passkey and funded, the bot key authorised and active.',
    seconds: 18,
    captions: [
      { at: 0.3, until: 4.35, text: 'Add Rolepay to *your server*' },
      { at: 4.8, until: 8.85, text: '`/rolepay setup` names the approver role' },
      { at: 9.3, until: 13.35, text: 'The treasurer creates the *treasury* with a passkey' },
      { at: 13.8, until: 17.85, text: 'The bot gets an *access key*: an expiry, a limit, one call' },
    ],
  },
  // "A role, a reaction or plain words: Rolepay finds the people"
  {
    type: 'slot',
    file: 'demo-3-right-click.mp4',
    kind: 'screen',
    label: "A message's menu",
    note: "A message's menu: Apps, Pay the author (a one-line run); then Draft pay run with AI on a winners post, the held line and the cost.",
    seconds: 19.9,
    captions: [
      { at: 0.3, until: 6.15, text: "A message's menu, Apps, *Pay the author*: a one-line run" },
      { at: 6.6, until: 10.65, text: 'Or *Draft pay run with AI* from a winners post' },
      { at: 11.05, until: 15.05, text: 'A line backed only by *their own message* is held' },
      { at: 15.45, until: 19.5, text: 'The footer shows what it cost: *about a cent*' },
    ],
  },
  // "One approval in Discord, one transaction, a receipt for every person"
  {
    type: 'slot',
    file: 'pitch-2-demo.mp4',
    kind: 'screen',
    label: 'A pay run, approved and paid',
    note: "The first mainnet run, the slow cut: /rolepay new and the run, the Treasurer's approval in #treasury with the payee's balance arriving, the DM receipt, the transaction on Tempo mainnet.",
    seconds: 25,
    captions: PAYRUN_SLOW_CAPTIONS,
    fallback: { file: 'demo-2-payrun.mp4', captions: PAYRUN_CAPTIONS },
  },
  // "Recipients need only a passkey"
  {
    type: 'slot',
    file: 'demo-9-judge.mp4',
    kind: 'screen',
    label: 'The judge flow',
    note: "As a judge: the welcome post's three steps in #start-here, then the 8 October 16:00 UTC run in #payouts, the account page receiving it live, and the DM receipt.",
    seconds: 16.4,
    captions: [
      { at: 0.3, until: 5.45, text: 'Judges join the demo, run `/payee link` and react ✅' },
      { at: 5.9, until: 16.0, text: 'Paid at the next daily run, *with nobody online*' },
    ],
  },
  // "Regular pay runs on its own, within its budget, with time to veto"
  {
    type: 'slot',
    file: 'demo-5-policy.mp4',
    kind: 'screen',
    label: 'A policy on autopilot',
    note: '/rolepay policy new and its draft, who it applies to and Approve policy in #treasury, autopilot with a one-minute veto window, then the same run paid a minute later.',
    seconds: 19,
    captions: [
      { at: 0.3, until: 6.15, text: 'A standing rule in plain words: `/rolepay policy new`' },
      { at: 6.6, until: 10.75, text: 'It shows *who it applies to* before anyone approves' },
      { at: 11.2, until: 18.6, text: 'On autopilot: a *veto window*, then it pays itself' },
    ],
  },
  {
    type: 'slot',
    file: 'demo-also-built.mp4',
    kind: 'screen',
    label: 'Also built',
    note: 'A slide: what else runs on the testnet demo.',
    seconds: 13,
    card: {
      kind: 'points',
      title: 'Also built',
      points: [
        'Paid in *the stablecoin each person prefers*',
        'A standing policy with *its own on-chain budget*',
        '*Funding sources*, each with its own deposit address',
        'A *dashboard* with an audit log and CSV export',
        '*Never pays twice*, through retries and crashes',
        'The AI only drafts: *code checks*, a Treasurer approves',
      ],
    },
  },
  { type: 'scene', scene: 'endCard' },
]
