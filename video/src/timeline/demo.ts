import type { CaptionCue } from '../components/Caption'
import type { Item } from './Assembly'

/** The captions of `demo-2-payrun.mp4`, timed to that take (the pitch borrows it when it has no cut of its own). */
export const PAYRUN_CAPTIONS: CaptionCue[] = [
  { at: 0.5, until: 3, text: '`/rolepay new` builds a run' },
  { at: 3.4, until: 8.5, text: 'A Treasurer approves in *#treasury*, and the money lands' },
  { at: 8.8, until: 12.8, text: 'A *receipt* by DM, and the transaction on *Tempo mainnet*' },
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
    note: '/rolepay setup, then the setup page: the treasury created with a passkey, funded, the bot key authorised.',
    seconds: 12.5,
    captions: [
      { at: 0.3, until: 2.2, text: 'Add Rolepay to *your server*' },
      { at: 2.45, until: 5.6, text: '`/rolepay setup` names the approver role' },
      { at: 5.9, until: 8.85, text: 'The treasurer creates the *treasury* with a passkey' },
      { at: 9.1, until: 12.1, text: 'The bot gets an *access key*: an expiry, a limit, one call' },
    ],
  },
  // "A role, a reaction or plain words: Rolepay finds the people"
  {
    type: 'slot',
    file: 'demo-3-right-click.mp4',
    kind: 'screen',
    label: "A message's menu",
    note: "A message's menu: Apps, Pay the author (a one-line run); then Draft pay run with AI on a winners post, the held line and the cost.",
    seconds: 13.9,
    captions: [
      { at: 0.3, until: 4.15, text: "A message's menu, Apps, *Pay the author*: a one-line run" },
      { at: 4.55, until: 7.6, text: 'Or *Draft pay run with AI* from a winners post' },
      { at: 7.95, until: 10.7, text: 'A line backed only by *their own message* is held' },
      { at: 11.0, until: 13.45, text: 'The footer shows what it cost: *about a cent*' },
    ],
  },
  // "One approval in Discord, one transaction, a receipt for every person"
  {
    type: 'slot',
    file: 'demo-2-payrun.mp4',
    kind: 'screen',
    label: 'A pay run, approved and paid',
    note: 'The first mainnet run: /rolepay new in #general, approved in #treasury while the payee\'s balance arrives, then the DM receipt and the explorer.',
    seconds: 13.2,
    captions: PAYRUN_CAPTIONS,
  },
  // "Recipients need only a passkey"
  {
    type: 'slot',
    file: 'demo-9-judge.mp4',
    kind: 'screen',
    label: 'The judge flow',
    note: "As a judge: the welcome post's three steps in #start-here, then the 8 October 16:00 UTC run in #payouts, the account page receiving it live, and the DM receipt.",
    seconds: 12,
    captions: [
      { at: 0.3, until: 4.15, text: 'Judges join the demo, run `/payee link` and react ✅' },
      { at: 4.5, until: 11.6, text: 'Paid at the next daily run, *with nobody online*' },
    ],
  },
  // "Regular pay runs on its own, within its budget, with time to veto"
  {
    type: 'slot',
    file: 'demo-5-policy.mp4',
    kind: 'screen',
    label: 'A policy on autopilot',
    note: '/rolepay policy new and its draft, who it applies to and Approve policy in #treasury, autopilot with a one-minute veto window, then the same run paid a minute later.',
    seconds: 13,
    captions: [
      { at: 0.3, until: 3.75, text: 'A standing rule in plain words: `/rolepay policy new`' },
      { at: 4.1, until: 6.55, text: 'It shows *who it applies to* before anyone approves' },
      { at: 6.9, until: 12.65, text: 'On autopilot: a *veto window*, then it pays itself' },
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
