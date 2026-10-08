import { STYLE, esc, head } from './page.js'
import { mark } from './theme.js'

/**
 * What the bot needs in a server (apps/server/README.md): View Channels (1024), Send Messages
 * (2048), Embed Links (16384, to update a pay run's message after a restart) and Read Message
 * History (65536, for AI proposals and the activity policies count). 84992 in all.
 */
export const BOT_PERMISSIONS = 1024 + 2048 + 16384 + 65536

/** Discord's "add to server" link for this application: the bot and its slash commands, with the permissions above. */
export function installUrl(applicationId: string): string {
  const q = new URLSearchParams({ client_id: applicationId, scope: 'bot applications.commands', permissions: String(BOT_PERMISSIONS) })
  return `https://discord.com/oauth2/authorize?${q}`
}

export const SOURCE_URL = 'https://github.com/FilipeAleixo/rolepay'

const TAGLINE = 'Pay the people who run your community, from Discord, in stablecoins on Tempo.'

/**
 * Line icons drawn on a 24 by 24 grid with one stroke weight and round ends: the film's icons
 * (video/src/components/Icons.tsx), so the site and the film match. Decorative: the text next to
 * each one carries the meaning. The colour is the text colour, set in CSS.
 */
const ICONS = {
  coins:
    '<ellipse cx="12" cy="6.8" rx="6.6" ry="2.6"/><path d="M5.4 6.8v5c0 1.4 3 2.6 6.6 2.6s6.6-1.2 6.6-2.6v-5"/><path d="M5.4 11.8v5c0 1.4 3 2.6 6.6 2.6s6.6-1.2 6.6-2.6v-5"/>',
  spark:
    '<path d="M10.5 3.5c.7 4.6 2.6 6.6 7 7.3-4.4.7-6.3 2.7-7 7.3-.7-4.6-2.6-6.6-7-7.3 4.4-.7 6.3-2.7 7-7.3Z"/><path d="M18.5 15.5c.3 1.9 1 2.7 2.9 3-1.9.3-2.6 1.1-2.9 3-.3-1.9-1-2.7-2.9-3 1.9-.3 2.6-1.1 2.9-3Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
  fingerprint:
    '<path d="M5.2 8.6A7.6 7.6 0 0 1 18.8 8.6"/><path d="M4.4 13.2a7.6 7.6 0 0 1 15.2 0c0 1.6-.2 3-.6 4.2"/><path d="M7 19.4c-.6-1.6-.9-3.6-.9-6a5.9 5.9 0 0 1 11.8 0c0 2-.3 3.8-.9 5.4"/><path d="M9.6 20.6c-.7-1.9-1.1-4.2-1.1-7.2a3.5 3.5 0 0 1 7 0c0 3-.4 5.3-1.2 7.2"/><path d="M12 13.4c0 3 .3 5.3 1 7.2"/>',
  swap: '<path d="M4 8.4h14.6"/><path d="M15 4.8l3.6 3.6-3.6 3.6"/><path d="M20 15.6H5.4"/><path d="M9 12l-3.6 3.6L9 19.2"/>',
  deposit: '<path d="M12 3.6v9.6"/><path d="M8.2 9.6 12 13.4l3.8-3.8"/><path d="M4 13.6v4.4c0 .8.6 1.4 1.4 1.4h13.2c.8 0 1.4-.6 1.4-1.4v-4.4"/>',
  vault:
    '<rect x="3.5" y="4" width="17" height="15" rx="2.6"/><circle cx="12" cy="11.5" r="3.6"/><path d="M12 7.9v1.3M12 13.8v1.3M8.4 11.5h1.3M14.3 11.5h1.3"/><path d="M6.5 19v1.6M17.5 19v1.6"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="M10.9 12.6 19.5 4"/><path d="M16.2 7.3l2.3 2.3"/><path d="M13.9 9.6l1.8 1.8"/>',
  /** Not in the film: a page with lines, the audit log. Drawn in the same hand as the vault. */
  log: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.6"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.2"/>',
} as const

const icon = (name: keyof typeof ICONS) =>
  `<span class="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg></span>`

/** What it does: a card each, an icon, a title and one sentence. */
const FEATURES: ReadonlyArray<{ icon: keyof typeof ICONS; title: string; line: string }> = [
  { icon: 'coins', title: 'Pay runs in one transaction.', line: 'Mods, staff and bounty winners, paid in one batch with a memo on every line.' },
  {
    icon: 'spark',
    title: 'AI drafts, a human approves.',
    line: 'From a message, or a rule like “everyone who helped in #support this week”. Nothing pays until the Treasurer approves.',
  },
  { icon: 'clock', title: 'Standing policies on autopilot.', line: 'Write the rule once. It runs on schedule, with a veto window and no AI at runtime.' },
  {
    icon: 'fingerprint',
    title: 'No wallet needed.',
    line: 'Recipients get a Tempo account with a passkey: no seed phrase, no gas. Or they use a wallet they already have.',
  },
  { icon: 'swap', title: 'The stablecoin they choose.', line: "Swapped on Tempo's stablecoin exchange inside the same transaction." },
  { icon: 'deposit', title: 'Funding with attribution.', line: 'Each sponsor gets its own deposit address. Every deposit is credited and labelled.' },
]

/** Why you can trust it: the trust model, a bold line and a muted line each. */
const TRUST: ReadonlyArray<{ icon: keyof typeof ICONS; bold: string; muted: string }> = [
  { icon: 'vault', bold: "The community's own account holds the funds.", muted: "Rolepay never does. Its root key is the treasurer's passkey." },
  {
    icon: 'key',
    bold: 'The bot, and each policy, holds only a key with a limit the chain enforces.',
    muted: 'Expiry, a spending limit per period, and one allowed call. Over the limit, Tempo refuses the whole batch.',
  },
  { icon: 'log', bold: 'Every run, approval and veto is in an audit log.', muted: 'On the dashboard, exportable as CSV.' },
]

/**
 * The home page at /: what Rolepay is, what it does, why you can trust it, and where to go next.
 * Server-rendered, no script. The same page on every network, but for the testnet pill. Without a
 * Discord application id there is no install link.
 */
export function landingPage(opts: { testnet: boolean; discordAppId?: string | undefined }): string {
  const install = opts.discordAppId ? `<a class="button secondary" href="${esc(installUrl(opts.discordAppId))}" rel="noreferrer">Add Rolepay to a server</a>` : ''
  const features = FEATURES.map((f) => `<li>${icon(f.icon)}<h3>${esc(f.title)}</h3><p>${esc(f.line)}</p></li>`).join('')
  const trust = TRUST.map((r) => `<li>${icon(r.icon)}<p><strong>${esc(r.bold)}</strong><span>${esc(r.muted)}</span></p></li>`).join('')
  return `<!doctype html>
<html lang="en">${head({ title: 'Rolepay', style: STYLE, description: TAGLINE, index: true })}
<body><main class="home">${opts.testnet ? '<p class="brand"><span class="testnet">Testnet demo</span></p>' : ''}
<h1 class="wordmark">${mark(52)}Rolepay</h1>
<p class="tagline">${TAGLINE}</p>
<section aria-labelledby="what"><h2 id="what">What it does</h2>
<ul class="features">${features}</ul></section>
<section aria-labelledby="trust"><h2 id="trust">Why you can trust it</h2>
<ul class="trust">${trust}</ul></section>
<nav class="cta" aria-label="Get started"><a class="button" href="/dashboard">Open the dashboard</a>${install}<a class="source" href="${SOURCE_URL}" rel="noreferrer">Source on GitHub</a></nav>
<p class="footnote">${esc("Built for Colosseum's Crypto World's Fair, Tempo track.")}</p>
</main></body></html>`
}
