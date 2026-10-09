import type { CaptionCue } from '../components/Caption'
import type { Item } from './Assembly'

/** The captions of `demo-2-payrun.mp4`, timed to that take (the pitch borrows it when it has no cut of its own). */
export const PAYRUN_CAPTIONS: CaptionCue[] = [
  { at: 0.5, until: 3, text: '`/rolepay new` builds a run' },
  { at: 3.4, until: 8.5, text: 'A Treasurer approves in *#treasury*, and the money lands' },
  { at: 8.8, until: 12.8, text: 'A *receipt* by DM, and the transaction on *Tempo mainnet*' },
]

/**
 * The demo (planned 2:56, hard limit 3:00): screen recordings of the live product with captions,
 * and the explainer scenes where they explain what the recording shows. Captions are timed in
 * seconds from the start of their clip; each slot's `note` says what its recording shows, so time
 * the clicks to its captions (or move `at` and `until` to fit the take). The slots are tight: trim
 * each recording to its planned length, or the studio's corner warning appears.
 */
export const DEMO: Item[] = [
  { type: 'scene', scene: 'title' },
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
  // What that access key can and cannot do.
  { type: 'scene', scene: 'trustModel' },
  {
    type: 'slot',
    file: 'demo-2-payrun.mp4',
    kind: 'screen',
    label: 'A pay run, approved and paid',
    note: 'The first mainnet run: /rolepay new in #general, approved in #treasury while the payee\'s balance arrives, then the DM receipt and the explorer.',
    seconds: 13.2,
    captions: PAYRUN_CAPTIONS,
  },
  // Why a double click, a retry or a crash cannot pay that run twice.
  { type: 'scene', scene: 'neverPayTwice' },
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
  // How a payee gets the stablecoin they chose, before the recording shows one.
  { type: 'scene', scene: 'preferredStablecoin' },
  {
    type: 'slot',
    file: 'demo-4-preferred.mp4',
    kind: 'screen',
    label: 'The stablecoin they choose',
    note: "/payee prefer BetaUSD from the payee's account, a run showing 5 AlphaUSD → 5 BetaUSD (swapped) and its Swaps limit, Approve, Paid, the payee's DM, then their account page reloaded.",
    seconds: 10.9,
    captions: [
      { at: 0.3, until: 2.45, text: 'A payee picks a stablecoin: `/payee prefer`' },
      { at: 2.8, until: 5.6, text: 'The run shows the *swap* and the most it may spend' },
      { at: 5.95, until: 10.55, text: 'Paid in *BetaUSD*, in the same transaction' },
    ],
  },
  // What a standing policy is, before the recording shows one.
  { type: 'scene', scene: 'fourBeats' },
  {
    type: 'slot',
    file: 'demo-5-policy.mp4',
    kind: 'screen',
    label: 'A policy on autopilot',
    note: '/rolepay policy new, the preview of who it applies to, Approve, autopilot with the veto window, then paid.',
    seconds: 13,
    captions: [
      { at: 0.5, until: 4, text: 'A standing rule in plain words: `/rolepay policy new`' },
      { at: 4.5, until: 8, text: 'It shows *who it applies to* before anyone approves' },
      { at: 8.5, until: 12.5, text: 'On autopilot: a *veto window*, then it pays itself' },
    ],
  },
  {
    type: 'slot',
    file: 'demo-6-policy-budget.mp4',
    kind: 'screen',
    label: "The policy's own budget",
    note: "Give the Judges policy its own budget on the treasury page (one passkey prompt), then the policy's dashboard page with its budget bar.",
    seconds: 10,
    captions: [
      { at: 0.5, until: 4.5, text: 'Give the Judges policy *its own budget*: one passkey prompt' },
      { at: 5, until: 9.5, text: 'Its page draws that budget *from the chain*' },
    ],
  },
  // What a key per policy buys: the chain caps each one on its own.
  { type: 'scene', scene: 'ownBudgets' },
  {
    type: 'slot',
    file: 'demo-7-dashboard.mp4',
    kind: 'screen',
    label: 'The dashboard',
    note: 'The web dashboard: the Overview with its At a glance panel, then the Audit log and its CSV.',
    seconds: 9,
    captions: [
      { at: 0.5, until: 4.5, text: "The dashboard: *At a glance*, the key's budget and its limit" },
      { at: 5, until: 8.5, text: 'Every step in the *audit log*, exportable to CSV' },
    ],
  },
  // How money comes in with its source attached, before the recording shows a deposit.
  { type: 'scene', scene: 'funding' },
  {
    type: 'slot',
    file: 'demo-8-funding.mp4',
    kind: 'screen',
    label: 'Funding',
    note: '/rolepay fund new for a source, its deposit address, then a deposit arriving on the dashboard\'s Funding page under that source.',
    seconds: 10,
    captions: [
      { at: 0.5, until: 4.5, text: '`/rolepay fund new`: a *deposit address* for each source' },
      { at: 5, until: 9.5, text: 'A deposit lands in the treasury, *attributed* to its source' },
    ],
  },
  {
    type: 'slot',
    file: 'demo-9-judge.mp4',
    kind: 'screen',
    label: 'The judge flow',
    note: 'As a judge: join the demo server, /payee link, create a passkey, react to the welcome post, get paid.',
    seconds: 12,
    captions: [
      { at: 0.5, until: 4, text: 'Judges join the demo server and run `/payee link`' },
      { at: 4.5, until: 7.5, text: 'Create a passkey, react to the welcome post' },
      { at: 8, until: 11.5, text: 'Paid at the next daily run, *with nobody online*' },
    ],
  },
  { type: 'scene', scene: 'endCard' },
]
