import { type Clock, type KeyState, type Policy, type PolicyKeyView, type Rolepay, describeSchedule, formatAmount, policyKeyDefaults } from '@rolepay/core'
import { type Context, Hono } from 'hono'
import type { WebConfig } from '../config.js'
import { failure, jsonResponse, linkStatus } from '../json.js'
import type { PasskeySessions } from '../ports.js'
import { esc, linkErrorPage, page } from '../views/page.js'
import { policyBudgetPage } from '../views/policyBudget.js'
import { DAY, keyPolicyRequest, keyRef, provesPasskey, tokenLabel, treasurerOf } from './treasurer.js'

export type PolicyBudgetRoutesDeps = { rolepay: Rolepay; sessions: PasskeySessions; config: WebConfig; clock: Clock; testnet: boolean }

const keyJson = (k: { key: PolicyKeyView; state: KeyState | null }) => ({ address: k.key.address, status: k.key.status, policy: k.key.policy, chain: k.state })

/** "Every Monday at 18:00 (UTC). At most 30 AlphaUSD per run." */
function about(p: Policy, token: string): string {
  const money = (m: bigint) => `${formatAmount(m)} ${token}`
  const caps = [p.caps.perRun === null ? null : `${money(p.caps.perRun)} per run`, p.caps.perPerson === null ? null : `${money(p.caps.perPerson)} per person`].filter(Boolean)
  return `${describeSchedule(p.schedule)}.${caps.length ? ` At most ${caps.join(', ')}.` : ''}`
}

/**
 * /setup/:token/policies/:policyId: a standing policy's own budget, on the treasury's page. The
 * same link and the same rules as the setup page (`treasurerOf`): every action needs the session of
 * the passkey that IS the treasury, proven by a sign-in. The page signs the policy key's
 * authorisation (built from its own form) and its revocation in the browser; the server mints and
 * seals the key and reads the result from the chain. Only this policy's keys are listed here, so the
 * page never revokes the bot key or another policy's key.
 */
export function policyBudgetRoutes(deps: PolicyBudgetRoutesDeps): Hono {
  const { rolepay, config } = deps
  const app = new Hono()
  const ref = (c: Context, guildId: string) => ({ guildId, policyId: c.req.param('policyId') as string })

  app.get('/setup/:token/policies/:policyId', async (c) => {
    const token = c.req.param('token')
    const link = await rolepay.communities.describeSetupLink({ token })
    if (!link.ok) return c.html(linkErrorPage(link.error.code, '/rolepay setup', deps.testnet), linkStatus(link.error.code) as 404)
    const community = link.value.community
    const plain = (status: 404 | 409, heading: string, body: string) => c.html(page({ title: 'Rolepay: policy budget', testnet: deps.testnet, body: `<h1>${heading}</h1><p>${body}</p>` }), status)
    if (!community) return plain(409, 'The treasury is not set up yet.', `Create the treasury first on <a href="/setup/${esc(encodeURIComponent(token))}">the setup page</a>.`)
    const found = await rolepay.policies.get(ref(c, community.id))
    if (!found.ok) return plain(404, 'There is no such policy here.', 'Check the link, or open the policy from <code>/rolepay policy show</code> in Discord.')
    const p = found.value
    const symbol = tokenLabel(community.payoutToken) as string
    const d = config.botKeyDefaults
    const defaults = policyKeyDefaults(p)
    return c.html(
      policyBudgetPage({
        page: 'policy-budget',
        token,
        policyId: p.id,
        policyName: p.name,
        policyStatus: p.status,
        guildName: community.name ?? 'your Discord server',
        network: config.network,
        testnet: deps.testnet,
        rpcUrl: config.rpcUrl,
        sponsorUrl: config.sponsorUrl,
        explorerUrl: config.explorerUrl,
        treasury: community.treasuryAddress,
        payoutToken: community.payoutToken,
        tokenLabel: symbol,
        feeMode: community.feeMode,
        feeToken: community.feeToken,
        feeTokenLabel: tokenLabel(community.feeToken),
        about: about(p, symbol),
        defaults: {
          limit: formatAmount(defaults.limit ?? d.limit),
          periodDays: Math.round(defaults.periodSeconds / DAY),
          validityDays: Math.round(d.validitySeconds / DAY),
          feeBudget: formatAmount(d.feeBudget),
        },
      }),
    )
  })

  app.get('/setup/:token/policies/:policyId/state', async (c) => {
    const link = await rolepay.communities.describeSetupLink({ token: c.req.param('token') })
    if (!link.ok) return failure(linkStatus(link.error.code), link.error)
    const community = link.value.community
    if (!community) return failure(409, { code: 'treasury_not_bound' })
    const [found, status, keys] = await Promise.all([rolepay.policies.get(ref(c, community.id)), rolepay.policyKeys.status(ref(c, community.id)), rolepay.policyKeys.listKeys(ref(c, community.id))])
    if (!found.ok || !status.ok || !keys.ok) return failure(404, { code: 'policy_not_found' })
    const session = await deps.sessions.current(c.req.raw)
    const own = session !== null && session.address === community.treasuryAddress
    return jsonResponse(200, {
      ok: true,
      policy: { id: found.value.id, name: found.value.name, status: found.value.status },
      // Whose budget pays its runs: the bot key's (`bot`), its own key (`own`), or nothing, its key revoked (`retired`).
      signs: status.value.signs,
      key: status.value.key ? keyJson({ key: status.value.key, state: status.value.state }) : null,
      // This policy's keys not yet revoked, and only this policy's: the page revokes the live ones.
      keys: keys.value.map(keyJson),
      session: session ? { address: session.address } : null,
      isTreasurer: own && provesPasskey(session, community),
      signInRequired: own && !provesPasskey(session, community),
    })
  })

  app.post('/setup/:token/policies/:policyId/key', async (c) => {
    const t = await treasurerOf(c, deps)
    if (!t.ok) return t.response
    const k = await keyPolicyRequest(c, t.value.community, deps.clock)
    if (!k.ok) return k.response
    const provisioned = await rolepay.policyKeys.provision({ ...ref(c, t.value.community.id), ...k.value })
    if (!provisioned.ok) {
      const code = provisioned.error.code
      return failure(code === 'policy_not_found' || code === 'community_not_found' ? 404 : code === 'policy_archived' ? 409 : 400, provisioned.error)
    }
    return jsonResponse(200, { ok: true, keyAddress: provisioned.value.keyAddress, treasury: provisioned.value.account, authorization: provisioned.value.authorization })
  })

  app.post('/setup/:token/policies/:policyId/key/confirm', async (c) => {
    const t = await treasurerOf(c, deps)
    if (!t.ok) return t.response
    const keyAddress = await keyRef(c)
    if (!keyAddress) return failure(400, { code: 'invalid_input', issues: ['keyAddress: the key this page authorised'] })
    // The audit names who the treasury page link was issued to; the passkey signed the key.
    const confirmed = await rolepay.policyKeys.confirm({ ...ref(c, t.value.community.id), keyAddress, actor: t.value.link.discordUserId })
    if (!confirmed.ok) return failure(409, confirmed.error)
    return jsonResponse(200, { ok: true, key: confirmed.value })
  })

  app.post('/setup/:token/policies/:policyId/key/revoked', async (c) => {
    const t = await treasurerOf(c, deps)
    if (!t.ok) return t.response
    const keyAddress = await keyRef(c)
    if (!keyAddress) return failure(400, { code: 'invalid_input', issues: ['keyAddress: the key this page revoked'] })
    const revoked = await rolepay.policyKeys.confirmRevocation({ ...ref(c, t.value.community.id), keyAddress, actor: t.value.link.discordUserId })
    if (!revoked.ok) return failure(409, revoked.error)
    return jsonResponse(200, { ok: true, key: revoked.value })
  })

  return app
}
