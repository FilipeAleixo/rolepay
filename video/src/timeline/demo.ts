import type { Item } from './Assembly'

/**
 * The demo (target 2:45, hard limit 3:00): screen recordings of the live product with a caption
 * each, and the explainer scenes where they explain what the recording shows. Captions are timed
 * in seconds from the start of their clip; SCRIPT.md says what to click so they line up.
 */
export const DEMO: Item[] = [
  { type: 'scene', scene: 'title' },
  {
    type: 'slot',
    file: 'demo-1-setup.mp4',
    kind: 'screen',
    label: 'Setup and the treasury passkey',
    note: '/rolepay setup, then the setup page: the treasury created with a passkey, funded, the bot key authorised.',
    seconds: 18,
    captions: [
      { at: 0.5, until: 5.5, text: '`/rolepay setup` names the approver role' },
      { at: 6, until: 11.5, text: 'The treasurer creates the *treasury* with a passkey' },
      { at: 12, until: 17.5, text: 'The bot gets an *access key*: an expiry, a limit, one call' },
    ],
  },
  // What that access key can and cannot do.
  { type: 'scene', scene: 'trustModel' },
  {
    type: 'slot',
    file: 'demo-2-payrun.mp4',
    kind: 'screen',
    label: 'A pay run, approved and paid',
    note: '/rolepay new for a role, Approve, the run paid in one transaction, then the DM receipt.',
    seconds: 21,
    captions: [
      { at: 0.5, until: 5.5, text: '`/rolepay new` builds a run for a *role*' },
      { at: 6, until: 10.5, text: 'The treasurer *approves* with one button' },
      { at: 11, until: 15.5, text: 'Paid in *one batched transaction*, one memo per line' },
      { at: 16, until: 20.5, text: 'Every payee gets a *DM receipt*' },
    ],
  },
  // Why a double click, a retry or a crash cannot pay that run twice.
  { type: 'scene', scene: 'neverPayTwice' },
  {
    type: 'slot',
    file: 'demo-3-pay-author.mp4',
    kind: 'screen',
    label: 'Pay the author',
    note: 'Right-click a message, Apps, Pay the author: the form, then the one-line run for review.',
    seconds: 12,
    captions: [
      { at: 0.5, until: 5.5, text: 'Right-click a message, Apps, *Pay the author*' },
      { at: 6, until: 11.5, text: 'A one-line run for its author, still *approved* by a human' },
    ],
  },
  // What a standing policy is, before the recording shows one.
  { type: 'scene', scene: 'fourBeats' },
  {
    type: 'slot',
    file: 'demo-4-policy.mp4',
    kind: 'screen',
    label: 'A policy on autopilot',
    note: '/rolepay policy new, the preview of who it applies to, Approve, autopilot with the veto window, then paid.',
    seconds: 21,
    captions: [
      { at: 0.5, until: 5.5, text: 'A standing rule in plain words: `/rolepay policy new`' },
      { at: 6, until: 10.5, text: 'It shows *who it applies to* before anyone approves' },
      { at: 11, until: 15.5, text: 'On autopilot, each run is posted with a *veto window*' },
      { at: 16, until: 20.5, text: "Then it pays itself, inside the key's *on-chain limit*" },
    ],
  },
  {
    type: 'slot',
    file: 'demo-5-ai-proposal.mp4',
    kind: 'screen',
    label: 'An AI proposal',
    note: 'Right-click the winners post, Draft pay run with AI: the proposal, the held line, the cost in the footer.',
    seconds: 16,
    captions: [
      { at: 0.5, until: 5, text: 'Right-click the winners post: *Draft pay run with AI*' },
      { at: 5.5, until: 10.5, text: 'A line backed only by *their own message* is held' },
      { at: 11, until: 15.5, text: 'The footer shows what it cost: *under half a cent*' },
    ],
  },
  {
    type: 'slot',
    file: 'demo-6-dashboard.mp4',
    kind: 'screen',
    label: 'The dashboard',
    note: 'The web dashboard: the Overview with its At a glance panel, then the Audit log and its CSV.',
    seconds: 17,
    captions: [
      { at: 0.5, until: 5.5, text: "The dashboard: *At a glance*, the key's budget and its limit" },
      { at: 6, until: 11, text: 'What was paid each week, by policy and by hand' },
      { at: 11.5, until: 16.5, text: 'Every step in the *audit log*, exportable to CSV' },
    ],
  },
  {
    type: 'slot',
    file: 'demo-7-judge.mp4',
    kind: 'screen',
    label: 'The judge flow',
    note: 'As a judge: join the demo server, /payee link, create a passkey, react to the welcome post, get paid.',
    seconds: 17,
    captions: [
      { at: 0.5, until: 5.5, text: 'Judges join the demo server and run `/payee link`' },
      { at: 6, until: 11, text: 'Create a passkey, react to the welcome post' },
      { at: 11.5, until: 16.5, text: 'Paid at the next daily run, *with nobody online*' },
    ],
  },
  { type: 'scene', scene: 'endCard' },
]
