import { describe, expect, it } from 'vitest'
import { webHarness } from '../../test/harness.js'
import { BOT_PERMISSIONS, installUrl, landingPage } from '../views/landing.js'

const APP_ID = '500000000000000001'
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] as string)
    .replace(/\s+/g, ' ')

describe('the home page (/)', () => {
  it('says what Rolepay is, the trust model in three lines, and where to go: the dashboard, the install link, the source', async () => {
    const res = await webHarness({ discordAppId: APP_ID }).send('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    const t = text(html)
    expect(html).toMatch(/<h1 class="wordmark"><svg class="mark"[^>]*aria-hidden="true"[\s\S]*<\/svg>Rolepay<\/h1>/)
    expect(t).toContain('Pay the people who run your community, from Discord, in stablecoins on Tempo.')
    expect(t).toContain("The community's own account holds the funds.")
    expect(t).toContain('The bot holds only a key with a limit the chain enforces.')
    expect(t).toContain('AI proposes, a human approves.')
    expect(html).toContain('<a class="button" href="/dashboard">Open the dashboard</a>')
    expect(html).toContain(`href="https://discord.com/oauth2/authorize?client_id=${APP_ID}&amp;scope=bot+applications.commands&amp;permissions=84992"`)
    expect(html).toContain('href="https://github.com/FilipeAleixo/rolepay"')
    expect(t).toContain('Testnet demo')
    // Server-rendered and calm: no script of any kind, and no em dashes in the copy.
    expect(html).not.toMatch(/<script/)
    expect(t).not.toContain('\u2014') // no em dash
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
