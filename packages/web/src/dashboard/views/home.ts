import { esc } from '../../views/page.js'
import { type HeaderViewer, messagePage, shell } from './layout.js'

export function signInPage(opts: { testnet: boolean; next?: string }): string {
  const href = opts.next && opts.next !== '/dashboard' ? `/auth/discord?next=${encodeURIComponent(opts.next)}` : '/auth/discord'
  return messagePage({
    title: 'dashboard',
    heading: 'Rolepay dashboard',
    testnet: opts.testnet,
    body: `<p class="lede">The pay runs, payees, policies and audit trail of your Discord communities.</p>
<p><a class="button" href="${esc(href)}">Sign in with Discord</a></p>
<p class="muted small">Rolepay reads your Discord name and the list of servers you are in, and nothing else. Members of a community see it read only; its Treasurer role can act.</p>`,
  })
}

export function notConfiguredPage(testnet: boolean): string {
  return messagePage({
    title: 'sign-in not configured',
    heading: 'Sign-in is not configured',
    testnet,
    body: `<p>This Rolepay server has no Discord OAuth2 client secret yet, so nobody can sign in to the dashboard.</p>
<p class="muted small">Its operator adds <code>ROLEPAY_DISCORD_CLIENT_SECRET</code> (Discord Developer Portal, OAuth2) and restarts it. Pay runs in Discord work without it.</p>`,
  })
}

/** Sign-in failures, in plain words. Never echoes what came in the URL. */
export function signInFailedPage(kind: 'cancelled' | 'invalid' | 'refused', testnet: boolean): string {
  const [heading, text] =
    kind === 'cancelled'
      ? ['Sign-in was cancelled', 'Discord did not share your account with Rolepay.']
      : kind === 'refused'
        ? ['Discord did not confirm the sign-in', 'Something went wrong between Rolepay and Discord. Try again in a moment.']
        : ['This sign-in link is not valid here', 'It expired, was already used, or was started in another browser.']
  return messagePage({ title: 'sign-in', heading, testnet, body: `<p>${text}</p><p><a class="button" href="/auth/discord">Sign in again</a></p>` })
}

export function homePage(opts: { testnet: boolean; viewer: HeaderViewer; communities: { id: string; name: string }[] }): string {
  const list = opts.communities.length
    ? `<ul class="card">${opts.communities.map((c) => `<li><a href="/dashboard/${esc(c.id)}">${esc(c.name)}</a></li>`).join('')}</ul>`
    : `<div class="card"><p>None of your servers use Rolepay yet.</p><p class="muted small">A server admin adds the bot and runs <code>/rolepay setup</code>. If you just joined one, sign out and in again so Discord shares the new list.</p></div>`
  return shell({
    title: 'Rolepay: your communities',
    testnet: opts.testnet,
    viewer: opts.viewer,
    body: `<h1>Your communities</h1><p class="lede">Servers you are in that use Rolepay.</p>${list}`,
  })
}
