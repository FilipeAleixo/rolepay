import { describe, expect, it } from 'vitest'
import { webHarness } from '../../test/harness.js'
import { BOT_PERMISSIONS, installUrl, landingPage } from '../views/landing.js'
import { esc } from '../views/page.js'

const APP_ID = '500000000000000001'
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] as string)
    .replace(/\s+/g, ' ')

/** What it does: six cards, each a title and one sentence. */
const FEATURES = [
  ['Pay runs in one transaction.', 'Mods, staff and bounty winners, paid in one batch with a memo on every line.'],
  ['AI drafts, a human approves.', 'From a message, or a rule like \u201ceveryone who helped in #support this week\u201d. Nothing pays until the Treasurer approves.'],
  ['Standing policies on autopilot.', 'Write the rule once. It runs on schedule, with a veto window and no AI at runtime.'],
  ['No wallet needed.', 'Recipients get a Tempo account with a passkey: no seed phrase, no gas. Or they use a wallet they already have.'],
  ['The stablecoin they choose.', "Swapped on Tempo's stablecoin exchange inside the same transaction."],
  ['Funding with attribution.', 'Each sponsor gets its own deposit address. Every deposit is credited and labelled.'],
] as const

/** Why you can trust it: three rows, each a bold line and a muted one. */
const TRUST = [
  ["The community's own account holds the funds.", "Rolepay never does. Its root key is the treasurer's passkey."],
  ['The bot, and each policy, holds only a key with a limit the chain enforces.', 'Expiry, a spending limit per period, and one allowed call. Over the limit, Tempo refuses the whole batch.'],
  ['Every run, approval and veto is in an audit log.', 'On the dashboard, exportable as CSV.'],
] as const

describe('the home page (/)', () => {
  it('says what Rolepay is, what it does, why you can trust it, and where to go: the dashboard, the install link, the source', async () => {
    const res = await webHarness({ discordAppId: APP_ID }).send('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    const t = text(html)
    expect(html).toMatch(/<h1 class="wordmark"><svg class="mark"[^>]*aria-hidden="true"[\s\S]*<\/svg>Rolepay<\/h1>/)
    expect(t).toContain('Pay the people who run your community, from Discord, in stablecoins on Tempo.')
    expect(html).toMatch(/<h2 id="what">What it does<\/h2>/)
    for (const [title, line] of FEATURES) {
      expect(html).toContain(`<h3>${esc(title)}</h3>`)
      expect(t).toContain(`${title} ${line}`)
    }
    expect(html).toMatch(/<h2 id="trust">Why you can trust it<\/h2>/)
    for (const [bold, muted] of TRUST) {
      expect(html).toContain(`<strong>${esc(bold)}</strong>`)
      expect(t).toContain(`${bold} ${muted}`)
    }
    expect(html).toContain('<a class="button" href="/dashboard">Open the dashboard</a>')
    expect(html).toContain(`href="https://discord.com/oauth2/authorize?client_id=${APP_ID}&amp;scope=bot+applications.commands&amp;permissions=84992"`)
    expect(html).toContain('href="https://github.com/FilipeAleixo/rolepay"')
    expect(t).toContain("Built for Colosseum's Crypto World's Fair, Tempo track.")
    expect(t).toContain('Testnet demo')
    // Server-rendered and calm: no script of any kind, and no em dashes in the copy.
    expect(html).not.toMatch(/<script/)
    expect(t).not.toContain('\u2014') // no em dash
  })

  it('reads in order without the pictures: one h1, the two section headings, a title per card, and every icon hidden from assistive tech', () => {
    const html = landingPage({ testnet: true })
    const headings = [...html.matchAll(/<h([1-6])[^>]*>/g)].map((m) => Number(m[1]))
    expect(headings).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 2])
    expect(html).toMatch(/<section aria-labelledby="what">/)
    expect(html).toMatch(/<section aria-labelledby="trust">/)
    const svgs = [...html.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0])
    expect(svgs).toHaveLength(1 + FEATURES.length + TRUST.length) // the mark, a line icon per card and per trust row
    for (const svg of svgs) {
      expect(svg).toContain('aria-hidden="true"')
      expect(svg).toContain('focusable="false"')
    }
    // The line icons: one 24 by 24 grid, one stroke weight, the gold coming from CSS (currentColor).
    for (const svg of svgs.slice(1)) expect(svg).toMatch(/viewBox="0 0 24 24"[^>]*fill="none" stroke="currentColor" stroke-width="1.5"/)
    // The CSP allows the stylesheet by hash and nothing else: a style attribute would be refused.
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('shows the same page on testnet and mainnet, but for the testnet pill', () => {
    const testnet = landingPage({ testnet: true, discordAppId: APP_ID })
    const mainnet = landingPage({ testnet: false, discordAppId: APP_ID })
    expect(testnet).toContain('<span class="testnet">Testnet demo</span>')
    expect(mainnet).not.toContain('Testnet')
    expect(mainnet).not.toContain('class="testnet"')
    expect(testnet.replace('<p class="brand"><span class="testnet">Testnet demo</span></p>', '')).toBe(mainnet)
  })

  it('offers the install link only when a Discord application is configured, on either network', async () => {
    for (const mainnet of [false, true]) {
      const without = await (await webHarness({ mainnet }).send('/')).text()
      expect(without, `mainnet ${mainnet}`).not.toContain('discord.com/oauth2')
      expect(without).not.toContain('Add Rolepay to a server')
      const withApp = await (await webHarness({ mainnet, discordAppId: APP_ID }).send('/')).text()
      expect(withApp, `mainnet ${mainnet}`).toContain(`<a class="button secondary" href="https://discord.com/oauth2/authorize?client_id=${APP_ID}&amp;`)
      expect(withApp).toContain('Add Rolepay to a server')
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
