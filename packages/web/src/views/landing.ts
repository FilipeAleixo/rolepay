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
  /** Not in the film: a receipt with a torn edge. Drawn in the same hand as the vault. */
  receipt: '<path d="M6.5 3.5h11v17l-1.85-1.3-1.85 1.3-1.8-1.3-1.85 1.3-1.8-1.3-1.85 1.3z"/><path d="M9.3 8.3h5.4M9.3 11.6h5.4M9.3 14.9h3.2"/>',
  /** Not in the film: a page with lines, the audit log. Drawn in the same hand as the vault. */
  log: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.6"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.2"/>',
} as const

type IconName = keyof typeof ICONS

const icon = (name: IconName, size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`

/** How a pay run works: four steps, the first two done once. */
const STEPS: ReadonlyArray<{ title: string; line: string }> = [
  { title: 'The community opens its own account', line: 'A treasurer creates it on Tempo with a passkey. The money stays there; Rolepay never holds it.' },
  { title: 'The bot gets an allowance', line: 'You choose how much it may spend each month, and until when. Tempo holds it to that, whatever happens to the bot.' },
  { title: 'You say who to pay', line: 'Pick a role or a list of people, or describe them in plain words. You see every name and amount before anything moves.' },
  { title: 'One approval pays everyone', line: 'One transaction, a memo on every line, a receipt in Discord for each person. Regular pay can run on its own, with time to stop each run.' },
]

/** Who it is for: what the people being paid get, and what the treasurer gets. `cool` takes the second accent. */
const FOR_PAYEES: ReadonlyArray<{ icon: IconName; title: string; line: string; cool?: boolean }> = [
  { icon: 'fingerprint', title: 'No wallet to set up.', line: 'Their account is a passkey on their phone or laptop. Anyone with a wallet can use that instead.' },
  { icon: 'swap', title: 'Paid in the coin they prefer.', line: 'Someone who would rather hold another stablecoin gets it, swapped inside the same transaction.', cool: true },
  { icon: 'receipt', title: 'A receipt every time.', line: 'Each payment arrives with a message in Discord and a link to the transaction.' },
]
const FOR_TREASURER: ReadonlyArray<{ icon: IconName; title: string; line: string; cool?: boolean }> = [
  { icon: 'clock', title: 'Regular pay runs itself.', line: 'Write the rule once. It runs on schedule, and you can stop any run before it pays.' },
  { icon: 'deposit', title: 'You know where money came from.', line: 'Each sponsor gets its own deposit address, so every deposit arrives labelled.', cool: true },
  { icon: 'coins', title: 'The budget in plain sight.', line: 'What the bot has left, the next runs and every payment, live on the dashboard.' },
]
/** Every feature on the page, in order. */
export const FEATURES = [...FOR_PAYEES, ...FOR_TREASURER]

/** Why you can trust it: the trust model, a statement and its proof each. */
const TRUST: ReadonlyArray<{ icon: IconName; bold: string; muted: string }> = [
  { icon: 'vault', bold: "Your community's account holds the money.", muted: "Rolepay never does. Only the treasurer's passkey controls the account." },
  { icon: 'key', bold: 'The bot can spend only its allowance.', muted: 'Its key has an expiry, a limit per period and one allowed action. Ask for more and Tempo refuses the whole batch.' },
  { icon: 'log', bold: 'Every payment leaves a record.', muted: 'Runs, approvals and vetoes are on the dashboard, and export to CSV.' },
]

/**
 * Today versus with Rolepay: the problem the page otherwise never states, one line each, so the
 * claims below it have something to answer. Every "with" line is something the product does now.
 */
const CONTRAST: ReadonlyArray<{ was: string; now: string }> = [
  { was: 'One wallet send at a time', now: 'One approval, one transaction for everyone' },
  { was: 'A spreadsheet to reconcile', now: 'A receipt for every person, and a CSV for every run' },
  { was: 'Every recipient needs a wallet and gas', now: 'Recipients need only a passkey, or the wallet they already have' },
  { was: 'Whoever holds the keys holds all the money', now: 'The bot can spend only what the chain allows' },
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
const productShot = () => `<div class="shot" role="img" aria-label="A pay run in Discord, paid in one transaction; the bot's allowance for the month with its on-chain limit; and the request it came from, in plain words, which Rolepay's AI turned into a rule before a treasurer approved it">
<div class="msg"><p class="who">${mark(32)}<b>Rolepay</b><span class="app">App</span><span class="when">Today at 18:00</span></p>
<div class="embed"><p class="e-title">Paid</p><p class="e-note">#help answers, September</p>
<ul class="lines">${PAYOUTS.map(([who, amount]) => `<li><span class="at">${who}</span><span class="amt">${amount} USDC.e</span></li>`).join('')}</ul>
<p class="e-status">Paid in one transaction. Approved by <span class="at">@Treasurer</span>.</p><p class="e-foot">Run 42</p></div></div>
<div class="budget"><p class="b-label">The bot's allowance this month</p><p class="b-amount"><strong>120</strong> of 200 USDC.e</p>
<div class="b-bar"><span class="b-fill"></span><span class="b-limit"></span></div>
<p class="b-row"><span>Resets in 12 days</span><span class="b-lim">On-chain limit</span></p>
<p class="b-cap">Over the limit, Tempo refuses the whole batch.</p></div>
<div class="ask"><p class="cmd">${icon('spark', 15)}Drafted by Rolepay's AI from your words</p><p class="said">“1 USDC.e for every question answered in <span class="ch">#help</span> this month, up to 40 each”</p><p class="ai-foot">The AI turned this into a rule. Rolepay counted who matches, and nothing was paid until <span class="at">@Treasurer</span> approved.</p></div>
</div>`

/**
 * The home page at /: what Rolepay is (with a picture of it working), the numbers, how it works,
 * the detail, why you can trust it, and where to go next. Server-rendered, no script; the light
 * behind the hero breathes in CSS only and holds still under reduced motion. The same page on
 * every network, but for the testnet pill. With a Discord application id (the server passes one
 * only when ROLEPAY_PUBLIC_INSTALL is on) "Add to Discord" leads; without one, the dashboard does.
 */
export function landingPage(opts: { testnet: boolean; discordAppId?: string | undefined }): string {
  const item = (f: (typeof FEATURES)[number]) => `<li${f.cool ? ' class="cool"' : ''}>${icon(f.icon, 22)}<p><strong>${esc(f.title)}</strong> ${esc(f.line)}</p></li>`
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
<p class="sub">Describe who to pay in plain words. Rolepay finds the people, a treasurer approves, and one transaction on Tempo pays them all from your community's own account.</p>
<p class="actions">${hero}<a class="more" href="#how">How it works</a></p></div>
${productShot()}</section>
<section class="contrast" aria-labelledby="contrast-title"><h2 id="contrast-title" class="sr">Paying people today, and with Rolepay</h2><p class="cols" aria-hidden="true"><span>Today</span><span>With Rolepay</span></p><ul>${CONTRAST.map((r) => `<li><p class="was"><span class="sr">Today: </span>${esc(r.was)}</p><p class="now"><span class="sr">With Rolepay: </span>${esc(r.now)}</p></li>`).join('')}</ul></section>
<section class="how" id="how" aria-labelledby="how-title"><div class="intro"><h2 id="how-title">How a pay run works</h2>
<p class="lede">Four steps. You do the first two once.</p></div>
<ol class="steps">${STEPS.map((s, i) => `<li><span class="n" aria-hidden="true">0${i + 1}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.line)}</p></div></li>`).join('')}</ol></section>
<section class="details" aria-labelledby="who"><h2 id="who">Who it is for</h2>
<div class="groups"><div class="group"><h3>The people you pay</h3><ul class="features">${FOR_PAYEES.map(item).join('')}</ul></div>
<div class="group"><h3>The treasurer</h3><ul class="features">${FOR_TREASURER.map(item).join('')}</ul></div></div></section>
<section class="trust" aria-labelledby="trust"><h2 id="trust">Why you can trust it</h2>
<ul>${TRUST.map((r) => `<li><span class="ic">${icon(r.icon, 24)}</span><p><strong>${esc(r.bold)}</strong><span>${esc(r.muted)}</span></p></li>`).join('')}</ul></section>
<section class="final" aria-labelledby="final-title"><h2 id="final-title">Pay your people from Discord.</h2>
<nav class="cta" aria-label="Get started">${final}<a class="source" href="${SOURCE_URL}" rel="noreferrer">Source on GitHub</a></nav>
<p class="footnote">${esc("Built for Colosseum's Crypto World's Fair, Tempo track.")}</p></section>
</main></body></html>`
}
