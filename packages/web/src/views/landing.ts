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
 * The home page at /: what Rolepay is, the trust model in three lines, and where to go next.
 * Server-rendered, no script. Without a Discord application id there is no install link.
 */
export function landingPage(opts: { testnet: boolean; discordAppId?: string | undefined }): string {
  const install = opts.discordAppId ? `<a class="button secondary" href="${esc(installUrl(opts.discordAppId))}" rel="noreferrer">Add Rolepay to a server</a>` : ''
  const facts = [
    "The community's own account holds the funds.",
    'The bot holds only a key with a limit the chain enforces.',
    'AI proposes, a human approves.',
  ]
  return `<!doctype html>
<html lang="en">${head({ title: 'Rolepay', style: STYLE, description: TAGLINE, index: true })}
<body><main class="home">${opts.testnet ? '<p class="brand"><span class="testnet">Testnet demo</span></p>' : ''}
<h1 class="wordmark">${mark(52)}Rolepay</h1>
<p class="tagline">${TAGLINE}</p>
<section aria-labelledby="trust"><h2 id="trust">The trust model</h2>
<ol class="trust">${facts.map((f, i) => `<li><span class="n" aria-hidden="true">${i + 1}</span><p>${esc(f)}</p></li>`).join('')}</ol></section>
<nav class="cta" aria-label="Get started"><a class="button" href="/dashboard">Open the dashboard</a>${install}<a class="source" href="${SOURCE_URL}" rel="noreferrer">Source on GitHub</a></nav>
</main></body></html>`
}
