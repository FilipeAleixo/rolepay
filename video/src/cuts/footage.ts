/**
 * The founder's recording of the first mainnet pay run (2026-10-08, 49.9 s, the full 3456 by 2234
 * screen). It lives in video/assets/ like every recording, gitignored. Two Chrome windows: on the
 * left his Discord on the "Rolepay Pilot" server; on the right the payee's account page, then the
 * payee's Discord DMs, then the explorer.
 *
 * Everything below is in source pixels and source seconds, measured on frame grabs.
 */
export const SOURCE = { file: 'mainnet-run.mov', width: 3456, height: 2234 } as const

export type Box = { x0: number; y0: number; x1: number; y1: number }

/**
 * The crops. Each is inside one window's page: below its tab strip and address bar (which show
 * unrelated tabs), above the Dock, and clear of Discord's server and channel sidebar (x < 500) and
 * of the DM list (x < 2280), so none of those can show. Each is the page's whole width, so a
 * viewer sees what the window is; the cuts scale them and never crop them further.
 */
const CROP = {
  // His Discord, the whole message pane: #general from the setup card down to the composer.
  general: { x0: 505, y0: 878, x1: 1736, y1: 2100 },
  // His Discord, #treasury: "Welcome to #treasury!" down to the run's buttons, between the
  // channel's icon (to 768) and the composer (from 1998). The same height as the account crop, so
  // the two panels match.
  treasury: { x0: 505, y0: 772, x1: 1736, y1: 1994 },
  // The payee's account page: the ROLEPAY mark, "Your Rolepay account", Balance and Received.
  account: { x0: 1985, y0: 340, x1: 3220, y1: 1562 },
  // The payee's DMs with Rolepay: "Rolepay#7129", the start of the history, then the receipt
  // with its buttons.
  dm: { x0: 2285, y0: 855, x1: 3452, y1: 1945 },
  // The explorer: the Mainnet pill, the transaction (Success, hash, block, time, From, To) and its
  // Overview (1 USDC.e to the payee, the balance updates).
  explorer: { x0: 1770, y0: 310, x1: 3440, y1: 1400 },
} as const satisfies Record<string, Box>

export type Panel = {
  box: Box
  /** A small label above the panel; periwinkle marks the Discord side, gold the rest. */
  label: string
  accent: 'periwinkle' | 'gold'
}

export type Beat = {
  /** The step number shown beside the caption. */
  step: string
  /** One short line; *words* are gold. */
  caption: string
  /** One panel, or two side by side (the two windows at the same moment). */
  panels: readonly Panel[]
  seconds: number
  /**
   * When each moment of the beat is in the recording: [beat seconds, source seconds] pairs, read
   * as straight lines between them (a flat stretch holds a frame). Both cuts play it the same.
   */
  time: readonly (readonly [number, number])[]
  /** Source seconds outside which the footage shows something else; the beat never leaves them. */
  safe: readonly [number, number]
}

const discord = (box: Box, channel: string): Panel => ({ box, label: `Discord · ${channel}`, accent: 'periwinkle' })
const ACCOUNT: Panel = { box: CROP.account, label: "The payee's account", accent: 'gold' }

/**
 * The four beats, at the recording's own speed except where noted. Cause and effect stay in one
 * picture: while he works in Discord on the left, the payee's page on the right is the same moment.
 */
export const BEATS = {
  // `/rolepay new amount:1 users:@Albert note:first mainnet run`: the note typed at twice the
  // speed (18.4 to 23.7 s; the "users" member list closed at 15 s), sent at 23.73 s, "Rolepay is
  // thinking..." at 24.5 s, the run in #general without buttons at 25.0 s and Rolepay's note
  // that a Treasurer approves it in the treasury channel at 25.25 s. The account page shows 0.
  send: {
    step: '01',
    caption: 'Pay from *Discord*',
    panels: [discord(CROP.general, '#general'), ACCOUNT],
    seconds: 6.0,
    time: [
      [0, 18.4],
      [2.65, 23.7],
      [6.0, 26.95],
    ],
    safe: [17.0, 26.95],
  },
  // #treasury, "Pay run awaiting approval"; the cursor reaches Approve and pay at 30.75 s and
  // clicks at 31.4 s. "Approved, paying..." at 32.13 s, "Paid" at 33.0 s. On the right the balance
  // counts 0 to 1 USDC.e from 32.89 s to 33.88 s and the Received row appears at 33.0 s. Until
  // 34.5 s the balance card's bottom padding collapses (a known glitch, fixed since): at this size
  // it is a faint edge behind the number and a small jump of the Received card when it settles,
  // left as it is. Then 2 s on the settled state ("Sent by DM to 1 person" at 35.75 s). The page
  // stays until 37.4 s.
  approve: {
    step: '02',
    caption: 'A *Treasurer* approves, and the payee is paid',
    panels: [discord(CROP.treasury, '#treasury'), ACCOUNT],
    seconds: 6.8,
    time: [
      [0, 29.7],
      [6.8, 36.5],
    ],
    safe: [29.0, 37.3],
  },
  // The payee's DM from Rolepay: "You were paid 1 USDC.e", with View transaction and Your account.
  // It settles at 40.0 s; at 40.8 s the cursor arrives and Discord's hover bar appears. A still
  // page, so the beat holds one frame of it.
  receipt: {
    step: '03',
    caption: 'A *receipt* for every person',
    panels: [{ box: CROP.dm, label: "The payee's Discord DMs", accent: 'periwinkle' }],
    seconds: 5.5,
    time: [
      [0, 40.3],
      [5.5, 40.3],
    ],
    safe: [40.0, 40.74],
  },
  // explore.tempo.xyz: Mainnet, Success, block 43214241, From the treasury, 1 USDC.e to the payee.
  // It loads at 44.5 s and its Overview settles at 45.25 s; the recording ends at 49.9 s, so the
  // last frame holds.
  explorer: {
    step: '04',
    caption: 'One transaction, on *Tempo mainnet*',
    panels: [{ box: CROP.explorer, label: 'The Tempo explorer', accent: 'gold' }],
    seconds: 6.0,
    time: [
      [0, 45.25],
      [4.6, 49.85],
      [6.0, 49.85],
    ],
    safe: [45.25, 49.85],
  },
} as const satisfies Record<string, Beat>

export type BeatId = keyof typeof BEATS

/**
 * The source second at `t` seconds into the beat (negative while it fades in): along its time
 * line, continued at its first stretch's speed before the start, held after the end, and kept
 * inside its safe window.
 */
export const sourceAt = (beat: Beat, t: number) => {
  const pts = beat.time
  let s = pts[pts.length - 1]![1]
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!]
    if (t <= b[0] || i === pts.length - 1) {
      s = t >= b[0] ? b[1] : a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0])
      break
    }
  }
  return Math.min(Math.max(s, beat.safe[0]), beat.safe[1])
}
