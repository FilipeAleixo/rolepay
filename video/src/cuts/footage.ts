/**
 * The first mainnet pay run, screen-recorded (2026-10-08, 49.9 s, the full 3456 by 2234 screen):
 * the treasurer's Discord on the "Rolepay Pilot" server on the left; on the right the payee's
 * account page, then the payee's Discord DMs, then the explorer. The file lives in video/assets/
 * like every recording, gitignored.
 *
 * Everything here is measured on frame grabs: boxes in source pixels, `from`/`to` of patches in
 * source seconds, everything else (camera, clip, highlight and shot timings) in seconds into the
 * beat.
 */
export const SOURCE = { file: 'mainnet-run.mov', width: 3456, height: 2234 } as const

export type Box = { x0: number; y0: number; x1: number; y1: number }
type Key<T> = readonly [number, T]

/**
 * A fix painted over the footage, in source pixels and source seconds: a flat `fill`, or the
 * recording itself, at this moment or at `plate` (another moment, when nothing covered the
 * region), with `even` evening out everything darker than text to the card's colour (so an edge
 * line or a darker gap disappears and the glyphs on it stay exactly as they are).
 */
export type Patch = { box: Box; from: number; to: number } & ({ fill: string } | { plate?: number; even?: boolean })

/** A calm ring around what changes, in source pixels, from `from` to `to` seconds into the beat. */
export type Highlight = { box: Box; from: number; to: number }

/**
 * One continuous piece of footage in a panel. `time` maps beat seconds to source seconds (straight
 * lines between keys, held after the last), kept inside `safe`. `camera` is the region the panel
 * shows (fitted to its shape, eased between keys); `clip` is the region allowed to show, every
 * edge fading out inward over `feather`, so a frame never ends on hard-cut text and nothing outside
 * the window's page can appear. `rows` drops empty bands: the listed source y-ranges are stacked,
 * and camera and clip y are then in the stacked coordinates. A later shot dissolves in at `from`.
 */
export type Shot = {
  from?: number
  time: readonly Key<number>[]
  safe: readonly [number, number]
  camera: readonly Key<Box>[]
  clip: readonly Key<Box>[]
  feather: { x: number; y: number }
  rows?: readonly (readonly [number, number])[]
  patches?: readonly Patch[]
  highlights?: readonly Highlight[]
}

export type Panel = {
  label: string
  /** Periwinkle marks the Discord side, gold the payee's page and the chain. */
  accent: 'periwinkle' | 'gold'
  /** The window's own background, behind whatever the clip hides. */
  bg: string
  /** The window's page: no clip reaches past it (tab strips, address bars, sidebars, Dock). */
  bounds: Box
  /** A panel alone in its beat: its shape (width over height); two panels share the layout's. */
  aspect?: number
  shots: readonly Shot[]
}

export type Beat = {
  /** The caption: a headline (*words* in gold) and a short line under it. */
  headline: string
  subline: string
  seconds: number
  panels: readonly Panel[]
}

/**
 * The pages. The left window's message pane starts right of the channel sidebar (x 505) and its
 * composer runs into the Dock at y 2096; the right window's page starts under its address bar.
 */
const DISCORD = { x0: 510, y0: 250, x1: 1712, y1: 2090 }
const PAGE = { x0: 1766, y0: 250, x1: 3450, y1: 2090 }
const DM = { x0: 2285, y0: 250, x1: 3450, y1: 2090 }

/** Background colours of the footage as its frames render (2 levels under ffmpeg's reading of the file). */
const BG = {
  discord: 'rgb(22, 22, 27)',
  hover: 'rgb(34, 34, 38)', // a Discord message row under the pointer
  discordAbove: 'rgb(23, 23, 26)', // the message above it, while the run is paying
  ephemeral: 'rgb(26, 25, 34)', // a message only its author sees
  page: 'rgb(14, 15, 19)',
  card: 'rgb(18, 18, 20)',
  explorer: 'rgb(11, 11, 11)',
} as const

/** The payee's account page: both cards (Balance, Received), and tight on the balance. */
const ACCOUNT_WIDE = { x0: 1985, y0: 760, x1: 3225, y1: 1520 }
const ACCOUNT_WIDE_CLIP = { x0: 1925, y0: 760, x1: 3285, y1: 1520 }
const ACCOUNT_TIGHT = { x0: 2012, y0: 905, x1: 2622, y1: 1160 }
const ACCOUNT_TIGHT_CLIP = { x0: 1990, y0: 790, x1: 2625, y1: 1160 }

const accountPanel = (shot: Shot): Panel => ({ label: "The payee's account page", accent: 'gold', bg: BG.page, bounds: PAGE, shots: [shot] })

export const BEATS = {
  // `/rolepay new amount:1 users:@Albert note:first mainnet run` in #general, the note finished at
  // 1.5 times the speed (19.6 to 23.7 s), then sent at 23.73 s. The run is in #general without
  // buttons from 25.33 s, with Rolepay's reply that a Treasurer approves it in the treasury
  // channel; the skipped 1.6 s between is "Sending command" and "Rolepay is thinking".
  send: {
    headline: 'A community pays its people *from Discord*',
    subline: 'One command: who gets paid, and how much.',
    seconds: 6.2,
    panels: [
      {
        label: 'Discord · #general',
        accent: 'periwinkle',
        bg: BG.discord,
        bounds: DISCORD,
        shots: [
          // The composer only (1858 to the window's edge), centred, its right end fading out
          // before Discord's icons.
          {
            time: [
              [0, 19.6],
              [2.73, 23.7],
            ],
            safe: [19.5, 23.7],
            camera: [[0, { x0: 515, y0: 1640, x1: 1365, y1: 2272 }]],
            clip: [[0, { x0: 505, y0: 1842, x1: 1362, y1: 2090 }]],
            feather: { x: 50, y: 18 },
          },
          // The run and the reply (1195 to 1890), between the setup card above and the reply's
          // "Only you can see this" below, held at 25.45 s: from 25.53 s the pointer, a text
          // cursor resting on the reply, tints its row. A plate from 27.2 s, when the pointer has
          // gone, covers the cursor itself.
          {
            from: 2.75,
            time: [[2.75, 25.45]],
            safe: [25.45, 25.45],
            camera: [[0, { x0: 520, y0: 1180, x1: 1712, y1: 1905 }]],
            clip: [[0, { x0: 505, y0: 1176, x1: 1715, y1: 1898 }]],
            feather: { x: 1, y: 16 },
            patches: [
              { box: { x0: 560, y0: 1712, x1: 1040, y1: 1762 }, from: 25.3, to: 26.5, fill: BG.ephemeral }, // "Message could not be loaded"
              { box: { x0: 1462, y0: 1806, x1: 1512, y1: 1862 }, from: 25.3, to: 26.5, plate: 27.2 },
            ],
            highlights: [{ box: { x0: 647, y0: 1242, x1: 1317, y1: 1672 }, from: 3.3, to: 5.8 }],
          },
        ],
      },
      accountPanel({
        time: [[0, 29.0]],
        safe: [29.0, 29.0],
        camera: [[0, ACCOUNT_WIDE]],
        clip: [[0, ACCOUNT_WIDE_CLIP]],
        feather: { x: 60, y: 16 },
      }),
    ],
  },
  // Real time from 29.8 s. #treasury: "Pay run awaiting approval"; Approve and pay clicked at
  // 31.4 s; "Approved, paying..." at 32.13 s; the "Paid" card at 33.1 s, a taller card that
  // scrolls the channel, so it gets its own framing, dissolving in once the pointer has left the
  // window (33.35 s). "Sent by DM to 1 person" at 35.75 s.
  // On the right the balance counts 0 to 1 USDC.e from 32.89 s to 33.88 s and the Received row
  // appears at 33.0 s. Until 34.48 s the balance card's bottom padding collapses (a known glitch,
  // fixed since): its bottom edge rises behind the number and the Received card moves up 40 px.
  // So the Received card fades out just before the count, the camera pushes in on the number while
  // it counts (the collapsed card's edge and the gap under it evened out to the card), and pulls
  // back once the card has settled, onto the new Received row.
  // The payee's pointer crosses the number at the end of the count (33.59 to 33.8 s): the right
  // panel skips that quarter second (0.966 straight to 1), running 0.25 s ahead of the left from
  // there, which no one can see. It then rests by "USDC.e" and parks under the number until
  // 35.95 s: covered by plates from moments it was elsewhere (34.45 s, then 36.6 s once the card
  // has settled). The settled page then holds.
  approve: {
    headline: 'The treasurer approves, and *the money lands*',
    subline: "One tap in the treasurers' channel. The payee's balance updates live.",
    seconds: 7.0,
    panels: [
      {
        label: 'Discord · #treasury',
        accent: 'periwinkle',
        bg: BG.discord,
        bounds: DISCORD,
        shots: [
          {
            time: [
              [0, 29.8],
              [7, 36.8],
            ],
            safe: [29.7, 33.07],
            // At 32.13 s the card loses its buttons and the channel shifts down 24 px, bringing the
            // new-messages divider (1386) into the frame: the clip's top follows it down.
            camera: [[0, { x0: 520, y0: 1385, x1: 1365, y1: 1958 }]],
            clip: [
              [0, { x0: 505, y0: 1380, x1: 1715, y1: 1957 }],
              [2.32, { x0: 505, y0: 1380, x1: 1715, y1: 1957 }],
              [2.34, { x0: 505, y0: 1392, x1: 1715, y1: 1957 }],
            ],
            feather: { x: 1, y: 14 },
            patches: [
              { box: { x0: 1262, y0: 1340, x1: 1700, y1: 1428 }, from: 29.7, to: 32.13, fill: BG.hover }, // the reactions bar
              // The reactions bar after the shift (1366 to 1446), over the message above (to 1403) and its own row.
              { box: { x0: 1262, y0: 1360, x1: 1700, y1: 1403 }, from: 32.13, to: 33.1, fill: BG.discordAbove },
              { box: { x0: 1262, y0: 1403, x1: 1700, y1: 1450 }, from: 32.13, to: 33.1, fill: BG.hover },
              { box: { x0: 1312, y0: 1430, x1: 1356, y1: 1472 }, from: 29.7, to: 32.15, fill: BG.hover }, // the embed's close button
              { box: { x0: 790, y0: 1906, x1: 828, y1: 1952 }, from: 32.12, to: 33.1, fill: BG.hover }, // the pointer, after the click
            ],
            highlights: [{ box: { x0: 641, y0: 1873, x1: 899, y1: 1943 }, from: 0.45, to: 1.75 }],
          },
          {
            from: 3.27,
            time: [
              [0, 29.8],
              [7, 36.8],
            ],
            safe: [33.35, 36.8],
            camera: [[0, { x0: 520, y0: 1180, x1: 1712, y1: 1905 }]],
            clip: [[0, { x0: 505, y0: 1170, x1: 1715, y1: 1908 }]],
            feather: { x: 1, y: 16 },
          },
        ],
      },
      accountPanel({
        time: [
          [0, 29.8],
          [3.77, 33.57],
          [3.771, 33.82],
          [5.85, 35.9],
        ],
        safe: [29.7, 35.9],
        camera: [
          [0, ACCOUNT_WIDE],
          [2.7, ACCOUNT_WIDE],
          [3.7, ACCOUNT_TIGHT],
          [4.75, ACCOUNT_TIGHT],
          [5.6, ACCOUNT_WIDE],
        ],
        clip: [
          [0, ACCOUNT_WIDE_CLIP],
          [2.55, ACCOUNT_WIDE_CLIP],
          [3.0, ACCOUNT_TIGHT_CLIP],
          [4.75, ACCOUNT_TIGHT_CLIP],
          [5.6, ACCOUNT_WIDE_CLIP],
        ],
        feather: { x: 60, y: 16 },
        patches: [
          // The collapsed card: its edge line (1120) through the number, the darker gap under it,
          // its rounded corners and the counter's faint halo, evened out to the card.
          { box: { x0: 1990, y0: 1068, x1: 3220, y1: 1161 }, from: 32.88, to: 34.49, even: true },
          // The pointer, by "USDC.e" and then under the number (the text ends at 1136): the rows of
          // the text from 34.45 s, when it had gone below them, and flat card below the text.
          { box: { x0: 2100, y0: 1075, x1: 2235, y1: 1137 }, from: 33.8, to: 34.49, plate: 34.45, even: true },
          { box: { x0: 2066, y0: 1137, x1: 2215, y1: 1178 }, from: 33.8, to: 34.49, fill: BG.card },
          { box: { x0: 2100, y0: 1126, x1: 2170, y1: 1185 }, from: 34.49, to: 35.95, plate: 36.6 },
        ],
        highlights: [
          { box: { x0: 2030, y0: 1076, x1: 2352, y1: 1154 }, from: 3.1, to: 4.6 },
          { box: { x0: 2030, y0: 1364, x1: 3155, y1: 1466 }, from: 5.5, to: 6.95 },
        ],
      }),
    ],
  },
  // The payee's DM from Rolepay, settled at 40.0 s (the pointer arrives at 40.8 s): held on one
  // frame, the message and its buttons, without the DM's header above or the composer below.
  receipt: {
    headline: 'Everyone paid gets *a receipt*',
    subline: 'A DM with the amount and the transaction.',
    seconds: 5.0,
    panels: [
      {
        label: "The payee's Discord DMs",
        accent: 'periwinkle',
        bg: BG.discord,
        bounds: DM,
        aspect: 1.62,
        shots: [
          {
            time: [[0, 40.3]],
            safe: [40.3, 40.3],
            camera: [[0, { x0: 2298, y0: 1245, x1: 3392, y1: 1934 }]],
            clip: [[0, { x0: 2280, y0: 1240, x1: 3455, y1: 1937 }]],
            feather: { x: 1, y: 16 },
            highlights: [{ box: { x0: 2420, y0: 1306, x1: 3384, y1: 1854 }, from: 0.5, to: 4.4 }],
          },
        ],
      },
    ],
  },
  // explore.tempo.xyz, once the pointer has left the page (48.25 s): the header (Mainnet) stacked
  // over the transaction down to its From row, without the empty band between them (410 to 566).
  // Real time to the end of the recording, then held.
  explorer: {
    headline: "One transaction, from *the community's own account*",
    subline: 'Settled on Tempo mainnet.',
    seconds: 6.0,
    panels: [
      {
        label: 'The Tempo explorer',
        accent: 'gold',
        bg: BG.explorer,
        bounds: PAGE,
        aspect: 1.99,
        shots: [
          {
            time: [
              [0, 48.3],
              [1.55, 49.85],
            ],
            safe: [48.3, 49.85],
            rows: [
              [318, 410],
              [566, 1306],
            ],
            camera: [[0, { x0: 1770, y0: 0, x1: 3440, y1: 832 }]],
            clip: [[0, { x0: 1772, y0: 0, x1: 3438, y1: 832 }]],
            feather: { x: 1, y: 12 },
            highlights: [
              { box: { x0: 2024, y0: 330, x1: 2232, y1: 395 }, from: 0.4, to: 2.2 }, // Mainnet
              { box: { x0: 2488, y0: 762, x1: 2612, y1: 806 }, from: 2.0, to: 3.8 }, // Success
              { box: { x0: 1793, y0: 1236, x1: 2632, y1: 1290 }, from: 3.6, to: 5.6 }, // From: the treasury
            ],
          },
        ],
      },
    ],
  },
} as const satisfies Record<string, Beat>

export type BeatId = keyof typeof BEATS

const lerp = (a: number, b: number, p: number) => a + (b - a) * p

/** The source second at `t` seconds into the beat: straight lines between keys, held outside them, kept in `safe`. */
export const sourceAt = (shot: Shot, t: number) => {
  const k = shot.time
  let s = k[0]![1]
  if (t >= k[k.length - 1]![0]) s = k[k.length - 1]![1]
  else
    for (let i = 1; i < k.length; i++) {
      const [a, b] = [k[i - 1]!, k[i]!]
      if (t >= a[0] && t < b[0]) {
        s = lerp(a[1], b[1], (t - a[0]) / (b[0] - a[0]))
        break
      }
    }
  return Math.min(Math.max(s, shot.safe[0]), shot.safe[1])
}

/** A box track at `t`: held before the first key and after the last, eased (`ease`) between keys. */
export const boxAt = (track: readonly Key<Box>[], t: number, ease: (p: number) => number): Box => {
  if (t <= track[0]![0]) return track[0]![1]
  for (let i = 1; i < track.length; i++) {
    const [a, b] = [track[i - 1]!, track[i]!]
    if (t < b[0]) {
      const p = ease((t - a[0]) / (b[0] - a[0]))
      return { x0: lerp(a[1].x0, b[1].x0, p), y0: lerp(a[1].y0, b[1].y0, p), x1: lerp(a[1].x1, b[1].x1, p), y1: lerp(a[1].y1, b[1].y1, p) }
    }
  }
  return track[track.length - 1]![1]
}

/** `box` grown to the panel's shape around its centre. */
export const fit = (box: Box, aspect: number): Box => {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const w = Math.max(box.x1 - box.x0, (box.y1 - box.y0) * aspect)
  const h = w / aspect
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }
}

/** A source y in a shot's coordinates: unchanged, or its place in the stacked `rows`. */
export const stackedY = (shot: Shot, y: number) => {
  if (!shot.rows) return y
  let offset = 0
  for (const [r0, r1] of shot.rows) {
    if (y <= r1) return offset + Math.max(0, y - r0)
    offset += r1 - r0
  }
  return offset
}
