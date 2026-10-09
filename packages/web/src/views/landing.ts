import { PAID_WEEKS, STYLE, esc, head } from './page.js'
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
  { title: 'You say who to pay', line: 'Pick a role or a list of people, or describe them in plain words to the AI. You see every name and amount before anything moves.' },
  { title: 'One approval pays everyone', line: 'One transaction, a memo on every line, a receipt in Discord for each person. Regular pay can run on its own, with time to stop each run.' },
]

/** A line of copy: words, and the name of a command or menu item as Discord shows it. */
type Line = ReadonlyArray<string | { cmd: string }>

/**
 * In Discord and on the web: where the work happens and where the record is kept. Each line is
 * something the product does now: the slash command and the "Pay the author" message command
 * (packages/discord), the approve and veto buttons, the receipt DMs; and the dashboard's Overview
 * (treasury, bot key budget, paid per week, funded this month, AI this month), Payees, Funding,
 * the audit log and each run's page with its transaction, the CSV exports (each run, the audit log)
 * and the payee's own account page, live over server-sent events.
 */
const IN_DISCORD: ReadonlyArray<Line> = [
  ['People sign up to be paid with ', { cmd: '/payee link' }, '.'],
  ['Start a run with ', { cmd: '/rolepay new' }, ', or right-click a message and choose ', { cmd: 'Pay the author' }, '.'],
  ['The treasurer approves it with one button.'],
  ['Runs that pay on their own wait first, so the treasurer can veto them.'],
  ['Everyone paid gets a receipt by DM, with a link to the transaction.'],
]
const ON_THE_WEB: ReadonlyArray<Line> = [
  ["The treasury's balance, and what the bot has left to spend."],
  ['What was paid each week, and what each person got.'],
  ['Every deposit, and the funding source it came in through.'],
  ['An estimate of what the AI cost this month, draft by draft.'],
  ['Every approval and veto, with who made it and when. Each paid run links its transaction.'],
  ['Any run, or the audit log, as a CSV.'],
]
const line = (l: Line) => l.map((p) => (typeof p === 'string' ? esc(p) : `<span class="cmd">${esc(p.cmd)}</span>`)).join('')

/**
 * The labels under the mock's bars, as the dashboard labels its weeks: counting back from "This week",
 * every other week when wide (`w`), every third when narrow (`n`). Placed by the stylesheet.
 */
const PAID_WEEK_TICKS: ReadonlyArray<{ text: string; on?: 'w' | 'n' }> = [
  { text: 'Aug 3' },
  { text: 'Aug 17', on: 'w' },
  { text: 'Aug 24', on: 'n' },
  { text: 'Aug 31', on: 'w' },
  { text: 'This week' },
]
const PAID_TOTAL = PAID_WEEKS.reduce((a, b) => a + b, 0)

/**
 * A small picture of the dashboard's "Paid per week" chart (dashboard/views/charts.ts): gold weekly
 * bars on a scale of 0 to 100 with its grid lines, every other week labelled, the week in progress
 * marked "so far". Made-up numbers; the heights come from PAID_WEEKS in the stylesheet. Static, and
 * one image to assistive tech.
 */
const paidWeeksMock = () => `<div class="weeks" role="img" aria-label="The dashboard's chart of what was paid per week: a gold bar for each of the last ${PAID_WEEKS.length} weeks, ${PAID_TOTAL} USDC.e in all, ${PAID_WEEKS.at(-1)} so far this week">
<p class="wk-label">Paid per week</p><p class="wk-amount"><strong>${PAID_TOTAL}</strong> USDC.e in the last ${PAID_WEEKS.length} weeks</p>
<div class="wk-chart"><p class="wk-axis"><span>100</span><span>50</span><span>0</span></p>
<p class="wk-bars">${PAID_WEEKS.map((_, i) => (i === PAID_WEEKS.length - 1 ? '<span><span class="sofar">so far</span></span>' : '<span></span>')).join('')}</p>
<p class="wk-ticks">${PAID_WEEK_TICKS.map((t) => `<span${t.on ? ` class="${t.on}"` : ''}>${t.text}</span>`).join('')}</p></div></div>`

/**
 * A receipt as Discord shows it, by DM (receiptDm in packages/discord): @mira's line of the hero's
 * run 42, with the two link buttons the real one carries, to the transaction and to her account
 * page. Static, and one image to assistive tech.
 */
const receiptMock = () => `<div class="dm" role="img" aria-label="A receipt in Discord, sent by DM: you were paid 30 USDC.e from The Commons, for pay run 42, line 1, with buttons to view the transaction and to open your account">
<p class="who">${mark(24)}<b>Rolepay</b><span class="app">App</span><span class="when">Today at 18:00</span></p>
<div class="embed"><p class="e-title">You were paid 30 USDC.e</p><p class="e-note">From <b>The Commons</b>, through Rolepay on Tempo.</p>
<p class="fields"><span><span class="f-name">To your account</span>0x7f3a…c21e</span><span><span class="f-name">Pay run</span>42, line 1</span></p></div>
<p class="links"><span>View transaction</span><span>Your account</span></p></div>`

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
  {
    icon: 'log',
    bold: 'Every payment leaves a record.',
    muted: 'Each paid run is on the dashboard with its transaction, and every approval and veto with who made it. Runs and the audit log export to CSV.',
  },
]

/**
 * Today versus with Rolepay: the problem the page otherwise never states, one line each, so the
 * claims below it have something to answer. Every "with" line is something the product does now.
 */
const CONTRAST: ReadonlyArray<{ was: string; now: string }> = [
  { was: 'Working out who did what by hand, from Discord into a spreadsheet', now: 'A role, a reaction or plain words: Rolepay finds the people' },
  { was: 'A multisig batch outside Discord, once enough signers are online', now: 'One approval in Discord, one transaction, a receipt for every person' },
  { was: 'Every recipient needs a wallet and gas', now: 'Recipients need only a passkey, or the wallet they already have' },
  { was: 'Regular pay needs someone online to sign it', now: 'Regular pay runs on its own, within its budget, with time to veto' },
]

/** The payouts in the product shot. Made-up people. */
const PAYOUTS = [
  ['@mira', '30'],
  ['@kofi', '30'],
  ['@ines', '40'],
  ['@theo', '20'],
] as const

/**
 * The product shot, in the order a run happens: the three ways to say who to pay (the AI's way last
 * and the only one in the accent), the paid run as Discord shows it, and the bot key's budget as the
 * dashboard's "At a glance" draws it (the limit a hard gold line). The run and the budget each say,
 * quietly, where they live: Discord and the dashboard. Static, and one image to assistive tech.
 */
const productShot = () => `<div class="shot" role="img" aria-label="The three ways to say who to pay: a role, people you pick, or plain words that Rolepay's AI drafts into a list; the pay run in Discord, paid in one transaction; and on the dashboard, the bot's allowance for the month with its on-chain limit">
<div class="ways"><p class="w-label">Who to pay</p><ul>
<li><span class="w-what"><span class="at">@Moderators</span></span><span class="w-how">a role</span></li>
<li><span class="w-what">${PAYOUTS.map(([who]) => `<span class="at">${who}</span>`).join(' ')}</span><span class="w-how">people you pick</span></li>
<li class="ai"><span class="w-what">${icon('spark', 15)}“1 USDC.e per question answered in <span class="ch">#help</span> this month, up to 40 each”</span><span class="w-how">in plain words, drafted by AI</span></li></ul>
<p class="ai-foot">The AI only drafts the list. You see every name before anything is paid.</p></div>
<div class="msg"><p class="who">${mark(32)}<b>Rolepay</b><span class="app">App</span><span class="when"><span class="day">Today at </span>18:00</span><span class="surface">Discord</span></p>
<div class="embed"><p class="e-title">Paid</p><p class="e-note">September</p>
<ul class="lines">${PAYOUTS.map(([who, amount]) => `<li><span class="at">${who}</span><span class="amt">${amount} USDC.e</span></li>`).join('')}</ul>
<p class="e-status">Paid in one transaction. Approved by <span class="at">@Treasurer</span>.</p><p class="e-foot">Run 42</p></div></div>
<div class="budget"><p class="b-head"><span class="b-label">The bot's allowance this month</span><span class="surface">Dashboard</span></p><p class="b-amount"><strong>120</strong> of 200 USDC.e</p>
<div class="b-bar"><span class="b-fill"></span><span class="b-limit"></span></div>
<p class="b-row"><span>Resets in 12 days</span><span class="b-lim">On-chain limit</span></p>
<p class="b-cap">Over the limit, Tempo refuses the whole batch.</p></div>
</div>`

/**
 * The home page at /: what Rolepay is (with a picture of it working), what it replaces, how it works,
 * the two places it lives (Discord and the web), the detail, why you can trust it, and where to go next, then a foot with the
 * name and what it was built for. Server-rendered, no script; the light
 * behind the hero breathes in CSS only and holds still under reduced motion. The same page on
 * every network, but for the testnet pill. With a Discord application id (the server passes one
 * only when ROLEPAY_PUBLIC_INSTALL is on) "Add to Discord" leads; without one, the dashboard does.
 * On testnet, with that install link and the demo's own Discord server (ROLEPAY_DEMO_INVITE_URL),
 * joining the demo and getting paid leads instead: the fastest way to see Rolepay work, with nobody
 * online. One gold button per screen: the second action is the periwinkle outline (`.button.cool`),
 * the colour the page gives Discord.
 */
export function landingPage(opts: { testnet: boolean; discordAppId?: string | undefined; demoInviteUrl?: string | undefined }): string {
  const item = (f: (typeof FEATURES)[number]) => `<li${f.cool ? ' class="cool"' : ''}>${icon(f.icon, 22)}<p><strong>${esc(f.title)}</strong> ${esc(f.line)}</p></li>`
  const href = opts.discordAppId ? esc(installUrl(opts.discordAppId)) : null
  const invite = opts.testnet && href && opts.demoInviteUrl ? esc(opts.demoInviteUrl) : null
  const dashboard = '<a class="button" href="/dashboard">Open the dashboard</a>'
  const install = (label: string, kind = 'button') => `<a class="${kind}" href="${href}" rel="noreferrer">${label}</a>`
  const join = (label: string, kind = 'button') => `<a class="${kind}" href="${invite}" rel="noreferrer">${label}</a>`
  // The people being paid come back on their phones, so their account link stays when Dashboard folds away.
  const account = '<a class="quiet account" href="/account"><span class="wide">Payee account</span><span class="narrow">Account</span></a>'
  const bar = href
    ? `${account}<a class="quiet" href="/dashboard">Treasury dashboard</a>${install('Add to Discord', invite ? 'button cool' : 'button')}`
    : `${account}<a class="button" href="/dashboard"><span class="wide">Treasury dashboard</span><span class="narrow">Dashboard</span></a>`
  const hero = invite ? `${join('Join the demo')}${install('Add to your server', 'button cool')}` : href ? install('Add to Discord') : dashboard
  // What a visitor does once in the demo server (the Judges policy in apps/server/README.md pays them).
  // With the hint, "How it works" follows it, so the hint sits right under the button it explains.
  const hint = invite ? '<p class="hint">Run <code>/payee link</code>, react ✅ in #start-here, and the next daily run pays you a test dollar.</p>' : ''
  const final = invite
    ? `${install('Add Rolepay to a server')}${join('Join the demo server', 'button cool')}`
    : href
      ? `${install('Add Rolepay to a server')}<a class="button secondary" href="/dashboard">Open the dashboard</a>`
      : dashboard
  return `<!doctype html>
<html lang="en">${head({ title: 'Rolepay', style: STYLE, description: TAGLINE, index: true })}
<body><div class="atmos" aria-hidden="true"><span class="glow warm"></span><span class="glow cool"></span></div>
<header class="topbar"><div class="bar"><p class="logo">${mark(28)}<span>Rolepay</span></p><nav aria-label="Main">${bar}</nav></div></header>
<main class="home">
<section class="hero" aria-labelledby="hero-title"><div class="copy">${opts.testnet ? '<p class="badge"><span class="testnet">Testnet demo</span></p>' : ''}
<h1 id="hero-title">Pay the people who run your community.</h1>
<p class="sub">Pick a role, name the people, or describe them in plain words to the AI. A treasurer approves, and one transaction on Tempo pays them all from your community's own account.</p>
${invite ? `<p class="actions pair">${hero}</p>${hint}<p class="down"><a class="more" href="#how">How it works</a></p>` : `<p class="actions">${hero}<a class="more" href="#how">How it works</a></p>`}</div>
${productShot()}</section>
<section class="contrast" aria-labelledby="contrast-title"><h2 id="contrast-title" class="sr">Paying people today, and with Rolepay</h2><p class="cols" aria-hidden="true"><span>Today</span><span>With Rolepay</span></p><ul>${CONTRAST.map((r) => `<li><p class="was"><span class="sr">Today: </span>${esc(r.was)}</p><p class="now"><span class="sr">With Rolepay: </span>${esc(r.now)}</p></li>`).join('')}</ul></section>
<section class="how" id="how" aria-labelledby="how-title"><div class="intro"><h2 id="how-title">How a pay run works</h2>
<p class="lede">Four steps. You do the first two once.</p></div>
<ol class="steps">${STEPS.map((s, i) => `<li><span class="n" aria-hidden="true">0${i + 1}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.line)}</p></div></li>`).join('')}</ol></section>
<section class="places" aria-labelledby="places-title"><h2 id="places-title">In Discord, and on the web</h2>
<p class="lede">You pay people from Discord. The dashboard keeps the record, and anyone in your server can sign in and read it.</p>
<div class="panes"><div class="pane cool"><h3>In Discord</h3><p class="where">Where the work happens.</p>
${receiptMock()}
<ul>${IN_DISCORD.map((l) => `<li>${line(l)}</li>`).join('')}</ul></div>
<div class="pane"><h3>On the web</h3><p class="where">Where you see all of it.</p>
${paidWeeksMock()}
<ul>${ON_THE_WEB.map((l) => `<li>${line(l)}</li>`).join('')}</ul>
<p class="also">${esc('People paid to a passkey account get a page of their own, where their balance and each payment show up live.')}</p></div></div></section>
<section class="details" aria-labelledby="who"><h2 id="who">Who it is for</h2>
<div class="groups"><div class="group"><h3>The people you pay</h3><ul class="features">${FOR_PAYEES.map(item).join('')}</ul></div>
<div class="group"><h3>The treasurer</h3><ul class="features">${FOR_TREASURER.map(item).join('')}</ul></div></div></section>
<section class="trust" aria-labelledby="trust"><h2 id="trust">Why you can trust it</h2>
<ul>${TRUST.map((r) => `<li><span class="ic">${icon(r.icon, 24)}</span><p><strong>${esc(r.bold)}</strong><span>${esc(r.muted)}</span></p></li>`).join('')}</ul></section>
<section class="final" aria-labelledby="final-title"><h2 id="final-title">Pay your people from Discord.</h2>
<nav class="cta" aria-label="Get started">${final}<a class="source" href="${SOURCE_URL}" rel="noreferrer">Source on GitHub</a></nav></section>
</main>
<footer class="foot"><p class="logo">${mark(22)}<span>Rolepay</span></p><p class="footnote">${esc("Built for Colosseum's Crypto World's Fair, Tempo track.")}</p></footer></body></html>`
}
