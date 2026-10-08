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

/** The page's description for search engines and link previews. */
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

type IconName = keyof typeof ICONS

const icon = (name: IconName, size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`

/** How it works: four steps, from the treasury to the record everyone can see. */
const STEPS: ReadonlyArray<{ title: string; line: string }> = [
  { title: 'Connect a treasury', line: "The community's own Tempo account, its root key a treasurer's passkey. Rolepay never holds the funds." },
  { title: 'Give the bot a budget', line: 'A key with an expiry, a spending limit per period and one allowed call. The chain enforces each one.' },
  { title: 'Pay', line: 'One run for a role or a list, approved with one button. Or a rule that runs on schedule, with a veto window.' },
  { title: 'Everyone sees it', line: 'A receipt by DM for each person, a live dashboard, and an audit log you can export as CSV.' },
]

/** What it does, in detail: one line each. `cool` takes the second accent, for rhythm. */
const FEATURES: ReadonlyArray<{ icon: IconName; title: string; line: string; cool?: boolean }> = [
  { icon: 'coins', title: 'Pay runs in one transaction.', line: 'Mods, staff and bounty winners, with a memo on every line.' },
  { icon: 'spark', title: 'AI drafts, a human approves.', line: 'From a message, or a rule like “everyone who helped in #support this week”.', cool: true },
  { icon: 'clock', title: 'Standing policies on autopilot.', line: 'Write the rule once. No AI at runtime.' },
  { icon: 'fingerprint', title: 'No wallet needed.', line: 'A passkey account: no seed phrase, no gas. Or a wallet they already have.' },
  { icon: 'swap', title: 'The stablecoin they choose.', line: "Swapped on Tempo's exchange inside the same transaction.", cool: true },
  { icon: 'deposit', title: 'Funding with attribution.', line: 'Each sponsor gets its own deposit address, every deposit labelled.' },
]

/** Why you can trust it: the trust model, a statement and its proof each. */
const TRUST: ReadonlyArray<{ icon: IconName; bold: string; muted: string }> = [
  { icon: 'vault', bold: "The community's own account holds the funds.", muted: "Rolepay never does. Its root key is the treasurer's passkey." },
  {
    icon: 'key',
    bold: 'The bot, and each policy, holds only a key with a limit the chain enforces.',
    muted: 'Expiry, a spending limit per period, and one allowed call. Over the limit, Tempo refuses the whole batch.',
  },
  { icon: 'log', bold: 'Every run, approval and veto is in an audit log.', muted: 'On the dashboard, exportable as CSV.' },
]

/**
 * By the numbers, as the README states them: the chain proofs it links on Moderato's explorer, the
 * default suite (rounded down, so it stays true as tests are added) and a warm AI proposal's cost.
 */
const PROOF: ReadonlyArray<{ value: string; label: string }> = [
  { value: '10', label: 'chain proofs on Tempo testnet' },
  { value: '1,800+', label: 'tests, no network needed' },
  { value: '$0.003', label: 'per AI proposal' },
]

/** The payouts in the product shot. Made-up people. */
const PAYOUTS = [
  ['@mira', '30'],
  ['@kofi', '30'],
  ['@ines', '40'],
  ['@theo', '20'],
] as const

/**
 * The product shot: a paid run as Discord shows it, and the bot key's budget as the dashboard's
 * "At a glance" draws it, the limit a hard gold line. Static, and one image to assistive tech.
 */
const productShot = () => `<div class="shot" role="img" aria-label="A pay run in Discord, paid in one transaction, and the bot key's budget for the period with its on-chain limit">
<div class="msg"><p class="who">${mark(32)}<b>Rolepay</b><span class="app">App</span><span class="when">Today at 18:00</span></p>
<div class="embed"><p class="e-title">Paid</p><p class="e-note">Weekly mods</p>
<ul class="lines">${PAYOUTS.map(([who, amount]) => `<li><span class="at">${who}</span><span class="amt">${amount} USDC.e</span></li>`).join('')}</ul>
<p class="e-status">Paid in one transaction. Approved by <span class="at">@Treasurer</span>.</p><p class="e-foot">Run 42</p></div></div>
<div class="budget"><p class="b-label">Bot key, spent this period</p><p class="b-amount"><strong>120</strong> of 200 USDC.e</p>
<div class="b-bar"><span class="b-fill"></span><span class="b-limit"></span></div>
<p class="b-row"><span>Resets in 12 days</span><span class="b-lim">On-chain limit</span></p>
<p class="b-cap">Over the limit, Tempo refuses the whole batch.</p></div>
</div>`

/**
 * The home page at /: what Rolepay is (with a picture of it working), the numbers, how it works,
 * the detail, why you can trust it, and where to go next. Server-rendered, no script; the light
 * behind the hero breathes in CSS only and holds still under reduced motion. The same page on
 * every network, but for the testnet pill. With a Discord application id (the server passes one
 * only when ROLEPAY_PUBLIC_INSTALL is on) "Add to Discord" leads; without one, the dashboard does.
 */
export function landingPage(opts: { testnet: boolean; discordAppId?: string | undefined }): string {
  const href = opts.discordAppId ? esc(installUrl(opts.discordAppId)) : null
  const dashboard = '<a class="button" href="/dashboard">Open the dashboard</a>'
  const install = (label: string) => `<a class="button" href="${href}" rel="noreferrer">${label}</a>`
  const bar = href ? `<a class="quiet" href="/dashboard">Dashboard</a>${install('Add to Discord')}` : dashboard
  const hero = href ? install('Add to Discord') : dashboard
  const final = href ? `${install('Add Rolepay to a server')}<a class="button secondary" href="/dashboard">Open the dashboard</a>` : dashboard
  return `<!doctype html>
<html lang="en">${head({ title: 'Rolepay', style: STYLE, description: TAGLINE, index: true })}
<body><div class="atmos" aria-hidden="true"><span class="glow warm"></span><span class="glow cool"></span></div>
<header class="topbar"><div class="bar"><p class="logo">${mark(28)}<span>Rolepay</span></p><nav aria-label="Main">${bar}</nav></div></header>
<main class="home">
<section class="hero" aria-labelledby="hero-title"><div class="copy">${opts.testnet ? '<p class="badge"><span class="testnet">Testnet demo</span></p>' : ''}
<h1 id="hero-title">Pay the people who run your community.</h1>
<p class="sub">From Discord, in stablecoins on Tempo. The money stays in the community's own account, and the bot can spend only what the chain allows.</p>
<p class="actions">${hero}<a class="more" href="#how">How it works</a></p></div>
${productShot()}</section>
<section class="proof" aria-label="By the numbers"><ul>${PROOF.map((p) => `<li><span class="num">${esc(p.value)}</span><span class="what">${esc(p.label)}</span></li>`).join('')}</ul></section>
<section class="how" id="how" aria-labelledby="how-title"><div class="intro"><p class="kicker">How it works</p><h2 id="how-title">From your treasury to a paid batch, with a person approving what matters.</h2>
<p class="lede">AI can draft a run. Only a person can approve it, and only the chain decides how much the bot can spend.</p></div>
<ol class="steps">${STEPS.map((s, i) => `<li><span class="n" aria-hidden="true">0${i + 1}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.line)}</p></div></li>`).join('')}</ol></section>
<section class="details" aria-labelledby="what"><h2 id="what">What it does</h2>
<ul class="features">${FEATURES.map((f) => `<li${f.cool ? ' class="cool"' : ''}>${icon(f.icon, 22)}<p><strong>${esc(f.title)}</strong> ${esc(f.line)}</p></li>`).join('')}</ul></section>
<section class="trust" aria-labelledby="trust"><h2 id="trust">Why you can trust it</h2>
<ul>${TRUST.map((r) => `<li><span class="ic">${icon(r.icon, 24)}</span><p><strong>${esc(r.bold)}</strong><span>${esc(r.muted)}</span></p></li>`).join('')}</ul></section>
<section class="final" aria-labelledby="final-title"><h2 id="final-title">Pay your people from Discord.</h2>
<nav class="cta" aria-label="Get started">${final}<a class="source" href="${SOURCE_URL}" rel="noreferrer">Source on GitHub</a></nav>
<p class="footnote">${esc("Built for Colosseum's Crypto World's Fair, Tempo track.")}</p></section>
</main></body></html>`
}
