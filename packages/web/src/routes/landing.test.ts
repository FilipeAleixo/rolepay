import { describe, expect, it } from 'vitest'
import { webHarness } from '../../test/harness.js'
import { BOT_PERMISSIONS, installUrl, landingPage } from '../views/landing.js'
import { STYLE, esc } from '../views/page.js'

const APP_ID = '500000000000000001'
const INSTALL = `https://discord.com/oauth2/authorize?client_id=${APP_ID}&amp;scope=bot+applications.commands&amp;permissions=84992`
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] as string)
    .replace(/\s+/g, ' ')
/** One part of the page, by its opening tag. */
const part = (html: string, open: RegExp, close: string) => {
  const m = open.exec(html)
  return m ? html.slice(m.index, html.indexOf(close, m.index)) : ''
}
const topBar = (html: string) => part(html, /<header class="topbar">/, '</header>')
const hero = (html: string) => part(html, /<section class="hero"/, '</section>')
const finalBand = (html: string) => part(html, /<section class="final"/, '</section>')

/** How a pay run works: four steps, a title and a line each. */
const STEPS = [
  ['The community opens its own account', 'A treasurer creates it on Tempo with a passkey. The money stays there; Rolepay never holds it.'],
  ['The bot gets an allowance', 'You choose how much it may spend each month, and until when. Tempo holds it to that, whatever happens to the bot.'],
  ['You say who to pay', 'Pick a role or a list of people, or describe them in plain words. You see every name and amount before anything moves.'],
  ['One approval pays everyone', 'One transaction, a memo on every line, a receipt in Discord for each person. Regular pay can run on its own, with time to stop each run.'],
] as const

/** Who it is for: the people you pay, then the treasurer, three lines each, a bold lead and the rest. */
const FOR_PAYEES = [
  ['No wallet to set up.', 'Their account is a passkey on their phone or laptop. Anyone with a wallet can use that instead.'],
  ['Paid in the coin they prefer.', 'Someone who would rather hold another stablecoin gets it, swapped inside the same transaction.'],
  ['A receipt every time.', 'Each payment arrives with a message in Discord and a link to the transaction.'],
] as const
const FOR_TREASURER = [
  ['Regular pay runs itself.', 'Write the rule once. It runs on schedule, and you can stop any run before it pays.'],
  ['You know where money came from.', 'Each sponsor gets its own deposit address, so every deposit arrives labelled.'],
  ['The budget in plain sight.', 'What the bot has left, the next runs and every payment, live on the dashboard.'],
] as const
const FEATURES = [...FOR_PAYEES, ...FOR_TREASURER]

/** Why you can trust it: three points, a statement and its proof each. */
const TRUST = [
  ["Your community's account holds the money.", "Rolepay never does. Only the treasurer's passkey controls the account."],
  ['The bot can spend only its allowance.', 'Its key has an expiry, a limit per period and one allowed action. Ask for more and Tempo refuses the whole batch.'],
  ['Every payment leaves a record.', 'Runs, approvals and vetoes are on the dashboard, and export to CSV.'],
] as const

describe('the home page (/)', () => {
  it('says what Rolepay is with a picture of it, what it replaces, how it works, what it does, why you can trust it, and where to go', async () => {
    const res = await webHarness({ discordAppId: APP_ID }).send('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    const t = text(html)
    expect(html).toContain('<h1 id="hero-title">Pay the people who run your community.</h1>')
    expect(t).toContain("Describe who to pay in plain words. Rolepay finds the people, a treasurer approves, and one transaction on Tempo pays them all from your community's own account.")
    expect(html).toContain('<meta name="description" content="Pay the people who run your community, from Discord, in stablecoins on Tempo.">')
    // The product shot: one image to assistive tech. A request in plain words, the run it became, paid, and the allowance with its on-chain limit.
    expect(hero(html)).toContain('<div class="shot" role="img" aria-label="A treasurer asks Rolepay in plain words to pay the people who answered questions in the help channel; the run, paid in one transaction; and the bot\'s allowance for the month with its on-chain limit">')
    expect(hero(html)).toContain('<p class="cmd">/rolepay propose</p><p class="said">1 USDC.e for every question answered in <span class="ch">#help</span> this month, up to 40 each</p>')
    expect(hero(html)).toContain('Paid in one transaction. Approved by <span class="at">@Treasurer</span>.')
    expect(t).toContain('On-chain limit')
    // What it replaces: today, and with Rolepay, row by row (screen readers hear which column each line is).
    expect(html).toContain('<h2 id="contrast-title" class="sr">Paying people today, and with Rolepay</h2>')
    for (const [was, now] of [
      ['One wallet send at a time', 'One approval, one transaction for everyone'],
      ['A spreadsheet to reconcile', 'A receipt for every person, and a CSV for every run'],
      ['Every recipient needs a wallet and gas', 'Recipients need only a passkey, or the wallet they already have'],
      ['Whoever holds the keys holds all the money', 'The bot can spend only what the chain allows'],
    ]) expect(html).toContain(`<li><p class="was"><span class="sr">Today: </span>${was}</p><p class="now"><span class="sr">With Rolepay: </span>${now}</p></li>`)
    expect(html).toContain('<h2 id="how-title">')
    expect(html).toContain('<h2 id="how-title">How a pay run works</h2>')
    expect(t).toContain('Four steps. You do the first two once.')
    STEPS.forEach(([title, line], i) => {
      expect(html).toContain(`<span class="n" aria-hidden="true">0${i + 1}</span><div><h3>${esc(title)}</h3>`)
      expect(t).toContain(`${title} ${line}`)
    })
    expect(html).toContain('<h2 id="who">Who it is for</h2>')
    expect(html).toContain('<h3>The people you pay</h3>')
    expect(html).toContain('<h3>The treasurer</h3>')
    for (const [lead, rest] of FEATURES) {
      expect(html).toContain(`<strong>${esc(lead)}</strong>`)
      expect(t).toContain(`${lead} ${rest}`)
    }
    expect(html).toContain('<h2 id="trust">Why you can trust it</h2>')
    for (const [bold, muted] of TRUST) {
      expect(html).toContain(`<strong>${esc(bold)}</strong>`)
      expect(t).toContain(`${bold} ${muted}`)
    }
    expect(finalBand(html)).toContain(`<a class="button" href="${INSTALL}" rel="noreferrer">Add Rolepay to a server</a><a class="button secondary" href="/dashboard">Open the dashboard</a>`)
    expect(html).toContain('href="https://github.com/FilipeAleixo/rolepay"')
    expect(t).toContain("Built for Colosseum's Crypto World's Fair, Tempo track.")
    expect(t).toContain('Testnet demo')
    // Server-rendered and calm: no script of any kind, and no em dashes in the copy.
    expect(html).not.toMatch(/<script/)
    expect(t).not.toContain('—') // no em dash
  })

  it('has a top bar: the mark and the name on the left; on the right the dashboard, quietly, then the gold "Add to Discord"', async () => {
    const html = await (await webHarness({ discordAppId: APP_ID }).send('/')).text()
    const bar = topBar(html)
    expect(bar).toMatch(/^<header class="topbar"><div class="bar"><p class="logo"><svg class="mark" width="28" height="28" aria-hidden="true"[\s\S]*<\/svg><span>Rolepay<\/span><\/p>/)
    expect(bar).toContain(`<nav aria-label="Main"><a class="quiet" href="/dashboard">Dashboard</a><a class="button" href="${INSTALL}" rel="noreferrer">Add to Discord</a></nav>`)
    // The hero leads with the same action, plus a way down the page.
    expect(hero(html)).toContain(`<p class="actions"><a class="button" href="${INSTALL}" rel="noreferrer">Add to Discord</a><a class="more" href="#how">How it works</a></p>`)
    expect(html).toContain('<section class="how" id="how"')
    // On a phone the bar keeps the mark, the name and the gold button; the dashboard link waits further down.
    expect(STYLE).toMatch(/@media \(max-width:40rem\)\{\.topbar \.quiet\{display:none\}/)
  })

  it('reads in order without the pictures: one h1, a heading per section, a title per step, and every icon and light hidden from assistive tech', () => {
    const html = landingPage({ testnet: true })
    const headings = [...html.matchAll(/<h([1-6])[^>]*>/g)].map((m) => Number(m[1]))
    expect(headings).toEqual([1, 2, 2, 3, 3, 3, 3, 2, 3, 3, 2, 2])
    for (const id of ['hero-title', 'contrast-title', 'how-title', 'who', 'trust', 'final-title']) expect(html).toContain(`aria-labelledby="${id}"`)
    expect(html).toContain('<div class="atmos" aria-hidden="true">')
    const svgs = [...html.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0])
    for (const svg of svgs) {
      expect(svg).toContain('aria-hidden="true"')
      expect(svg).toContain('focusable="false"')
    }
    // The line icons, one per detail and per trust point: one 24 by 24 grid, one stroke weight, the colour from CSS.
    const icons = svgs.filter((svg) => !svg.includes('class="mark"'))
    expect(icons).toHaveLength(FEATURES.length + TRUST.length)
    for (const svg of icons) expect(svg).toMatch(/viewBox="0 0 24 24"[^>]*fill="none" stroke="currentColor" stroke-width="1.5"/)
    // The CSP allows the stylesheet by hash and nothing else: a style attribute would be refused.
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('lets the light breathe only in CSS, on opacity and transform, and holds it still under reduced motion', () => {
    const keyframes = [...STYLE.matchAll(/@keyframes (rp-breathe[\w-]*)\{([^@]*?)\}\}/g)]
    expect(keyframes.map((k) => k[1])).toEqual(['rp-breathe', 'rp-breathe-cool'])
    for (const [, , body] of keyframes) {
      const properties = [...(body as string).matchAll(/([a-z-]+):/g)].map((m) => m[1])
      expect(new Set(properties)).toEqual(new Set(['opacity', 'transform']))
    }
    // The animation is declared only for people who have not asked for less motion.
    const animated = [...STYLE.matchAll(/animation:rp-breathe/g)].map((m) => m.index as number)
    expect(animated.length).toBe(2)
    const gate = STYLE.indexOf('@media (prefers-reduced-motion:no-preference){.glow')
    expect(gate).toBeGreaterThan(-1)
    for (const at of animated) expect(at).toBeGreaterThan(gate)
    expect(STYLE.slice(gate, STYLE.indexOf('\n', gate))).toContain('animation:rp-breathe-cool')
  })

  it('shows the same page on testnet and mainnet, but for the testnet pill', () => {
    const testnet = landingPage({ testnet: true, discordAppId: APP_ID })
    const mainnet = landingPage({ testnet: false, discordAppId: APP_ID })
    expect(testnet).toContain('<span class="testnet">Testnet demo</span>')
    expect(mainnet).not.toContain('Testnet')
    expect(mainnet).not.toContain('class="testnet"')
    expect(testnet.replace('<p class="badge"><span class="testnet">Testnet demo</span></p>', '')).toBe(mainnet)
  })

  it('offers the install link only with a Discord application and ROLEPAY_PUBLIC_INSTALL on (by default on testnet, off on mainnet, where the pilot bot is private)', async () => {
    const cases: Array<[Parameters<typeof webHarness>[0], boolean]> = [
      [{ discordAppId: APP_ID }, true],
      [{ discordAppId: APP_ID, publicInstall: false }, false],
      [{ mainnet: true, discordAppId: APP_ID }, false],
      [{ mainnet: true, discordAppId: APP_ID, publicInstall: true }, true],
      [{ publicInstall: true }, false], // no application, nothing to install
    ]
    const dashboard = '<a class="button" href="/dashboard">Open the dashboard</a>'
    for (const [opts, offered] of cases) {
      const html = await (await webHarness(opts).send('/')).text()
      const label = JSON.stringify(opts)
      if (offered) {
        expect(topBar(html), label).toContain(`<a class="quiet" href="/dashboard">Dashboard</a><a class="button" href="${INSTALL}" rel="noreferrer">Add to Discord</a>`)
        expect(finalBand(html), label).toContain('Add Rolepay to a server')
      } else {
        // The gold action becomes the dashboard everywhere, and nothing points at Discord's install page.
        expect(html, label).not.toContain('discord.com/oauth2')
        expect(html, label).not.toContain('Add to Discord')
        expect(html, label).not.toContain('Add Rolepay to a server')
        expect(topBar(html), label).toContain(`<nav aria-label="Main">${dashboard}</nav>`)
        expect(hero(html), label).toContain(`<p class="actions">${dashboard}<a class="more" href="#how">How it works</a></p>`)
        expect(finalBand(html), label).toContain(`<nav class="cta" aria-label="Get started">${dashboard}<a class="source"`)
      }
    }
  })

  it('builds the install link for the bot and its slash commands, with the permissions the bot uses', () => {
    const url = new URL(installUrl(APP_ID))
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe(APP_ID)
    expect(url.searchParams.get('scope')).toBe('bot applications.commands')
    // View Channels, Send Messages, Embed Links and Read Message History, as apps/server/README.md asks.
    expect(BOT_PERMISSIONS).toBe((1 << 10) | (1 << 11) | (1 << 14) | (1 << 16))
    expect(url.searchParams.get('permissions')).toBe('84992')
  })

  it('on mainnet says nothing about a testnet; without a Discord application there is no install link', async () => {
    const html = await (await webHarness({ mainnet: true }).send('/')).text()
    expect(html).not.toContain('Testnet demo')
    expect(html).not.toContain('class="testnet"')
    expect(html).not.toContain('discord.com/oauth2')
    expect(html).toContain('href="/dashboard"')
  })

  it('escapes what it is given', () => {
    const html = landingPage({ testnet: true, discordAppId: '1"><script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('client_id=1%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E')
  })

  it('is served with the same strict CSP, which allows the fonts, the favicon and the home-screen icon from this origin and nothing new besides', async () => {
    const h = webHarness({ discordAppId: APP_ID })
    const res = await h.send('/')
    const csp = res.headers.get('content-security-policy') ?? ''
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
    expect(Object.keys(directives)).toEqual(['default-src', 'script-src', 'style-src', 'connect-src', 'img-src', 'font-src', 'form-action', 'frame-ancestors', 'base-uri', 'object-src'])
    expect(directives['default-src']).toEqual(["'none'"])
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['style-src']).toHaveLength(2) // the pages' stylesheet and the dashboard's, each by hash
    for (const s of directives['style-src'] ?? []) expect(s).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/)
    expect(directives['img-src']).toEqual(["'self'", 'data:'])
    expect(directives['font-src']).toEqual(["'self'"])
    expect(directives['connect-src']).toEqual(["'self'", 'https://rpc.moderato.tempo.xyz', 'https://sponsor.moderato.tempo.xyz'])
    // Every font, the favicon and the home-screen icon the page refers to are on this origin (img-src
    // 'self' covers the icons, unchanged), and are served.
    const html = await res.text()
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"|url\(([^)"]+)\)/g)].map((m) => (m[1] ?? m[2]) as string).filter((u) => /\.(woff2|svg|png)$/.test(u))
    expect(refs).toContain('/favicon.svg')
    expect(refs).toContain('/apple-touch-icon.png')
    expect(refs.filter((u) => u.endsWith('.woff2')).length).toBeGreaterThanOrEqual(4)
    for (const u of new Set(refs)) {
      expect(u.startsWith('/')).toBe(true)
      expect((await h.send(u)).status, u).toBe(200)
    }
  })
})
