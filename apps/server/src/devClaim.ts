import { randomBytes } from 'node:crypto'
import type { PayeeService } from '@payrun/core'
import { Hono } from 'hono'

/**
 * A throwaway TESTNET claim page at /claim/:token, so /payee link can be tried end to
 * end before the passkey claim page (WP5) exists. It registers a pasted address, or a
 * fresh random one nobody holds the key to. Enabled only by PAYRUN_DEV_CLAIM=true and
 * refused on mainnet by config.
 */
export function devClaimRoutes(payees: PayeeService): Hono {
  const app = new Hono()

  app.get('/claim/:token', async (c) => {
    const token = c.req.param('token')
    const link = await payees.describeLink({ token })
    if (!link.ok) return c.html(page('This link does not work', linkError(link.error.code)), link.error.code === 'link_not_found' ? 404 : 410)
    return c.html(
      page(
        'Register where you get paid',
        `<p>This one-time link is for Discord user <code>${esc(link.value.discordUserId)}</code> in <strong>${esc(link.value.communityName ?? link.value.guildId)}</strong>.</p>
        ${form(token, '')}`,
      ),
    )
  })

  app.post('/claim/:token', async (c) => {
    const token = c.req.param('token')
    const body = await c.req.parseBody()
    const pasted = typeof body.address === 'string' ? body.address.trim() : ''
    const address = pasted || `0x${randomBytes(20).toString('hex')}`
    const registered = await payees.register({ token, address })
    if (registered.ok) {
      return c.html(
        page(
          'Registered',
          `<p>Payments from this server will go to <code>${esc(registered.value.address)}</code>.</p>
          ${pasted ? '' : '<p>This is a fresh throwaway testnet address: transfers to it are real testnet transfers, but nobody holds its key.</p>'}
          <p>You can close this page.</p>`,
        ),
      )
    }
    const e = registered.error
    if (e.code === 'invalid_input') return c.html(page('That address does not look right', `<p>${esc(e.issues.join('; '))}</p>${form(token, pasted)}`), 400)
    return c.html(page('This link does not work', linkError(e.code)), e.code === 'link_not_found' ? 404 : 410)
  })

  return app
}

function linkError(code: string): string {
  if (code === 'link_expired') return '<p>The link has expired. Run <code>/payee link</code> in Discord for a new one.</p>'
  if (code === 'link_already_used') return '<p>The link was already used. Run <code>/payee link</code> in Discord for a new one.</p>'
  return '<p>This link is not valid. Run <code>/payee link</code> in Discord for a new one.</p>'
}

const form = (token: string, value: string) => `
  <form method="post" action="/claim/${encodeURIComponent(token)}">
    <label>Tempo testnet address (leave empty for a throwaway one)<br>
      <input name="address" value="${esc(value)}" placeholder="0x..." size="46" autocomplete="off"></label>
    <p><button type="submit">Register</button></p>
  </form>`

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>payrun: ${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{word-break:break-all}.dev{color:#a15c00}</style>
</head><body><p class="dev">payrun dev claim page (testnet only)</p><h1>${esc(title)}</h1>${body}</body></html>`

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}
