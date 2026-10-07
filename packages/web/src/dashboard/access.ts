import { type Community, DiscordIdSchema } from '@rolepay/core'
import type { Context } from 'hono'
import { type DashboardKit, html } from './kit.js'
import type { PolicyActor } from './policyPort.js'
import { type DashboardSession, sameSecret } from './sessions.js'
import { signInPage } from './views/home.js'
import type { HeaderViewer } from './views/layout.js'
import { messagePage } from './views/layout.js'

/** Who is looking at a community page, as the bot sees them right now. */
export type Viewer = HeaderViewer & {
  userId: string
  roles: string[]
  /** Holds the community's approver (Treasurer) role: may act. Everyone else reads. */
  canAct: boolean
}

export type CommunityAccess = { community: Community; communityName: string; viewer: Viewer; session: DashboardSession }

type Access = { ok: true; value: CommunityAccess } | { ok: false; response: Response }

const NO_ACCESS = (kit: DashboardKit, session: DashboardSession) =>
  messagePage({
    title: 'no access',
    heading: 'You do not have access to this community',
    testnet: kit.testnet,
    viewer: { userName: session.userName, csrf: session.csrf },
    body: '<p>Either it does not use Rolepay, or Discord does not show you as a member of it right now.</p><p><a href="/dashboard">Your communities</a></p>',
  })

/**
 * Who may see a community's pages: someone signed in whom the bot sees as a member of that guild
 * right now (Discord REST as the bot, cached for a minute; `fresh` for actions). Roles come only
 * from that view, never from the browser or the sign-in snapshot. A guild that does not use
 * Rolepay and one the person is not in get the same answer, so the page reveals neither.
 */
export async function communityAccess(kit: DashboardKit, c: Context, opts: { fresh?: boolean } = {}): Promise<Access> {
  const guildId = c.req.param('guildId') ?? ''
  if (!DiscordIdSchema.safeParse(guildId).success) {
    return { ok: false, response: html(messagePage({ title: 'not found', heading: 'Not found', testnet: kit.testnet, body: '<p><a href="/dashboard">Your communities</a></p>' }), 404) }
  }
  const current = await kit.session(c.req.raw)
  if (!current) {
    const url = new URL(c.req.url)
    return { ok: false, response: html(signInPage({ testnet: kit.testnet, next: url.pathname + url.search }), 401) }
  }
  const { session } = current
  const [community, member] = await Promise.all([kit.rolepay.communities.get(guildId), kit.members.member(guildId, session.userId, opts)])
  if (!community.ok || !member) return { ok: false, response: html(NO_ACCESS(kit, session), 403) }
  const approver = community.value.approverRoleId
  const canAct = approver !== null && member.roles.includes(approver)
  return {
    ok: true,
    value: {
      community: community.value,
      communityName: community.value.name ?? session.guilds.find((g) => g.id === guildId)?.name ?? 'This community',
      viewer: { userId: session.userId, userName: member.name ?? session.userName, csrf: session.csrf, roles: member.roles, canAct },
      session,
    },
  }
}

/**
 * The gate in front of every dashboard action: a same-session CSRF token, then the member's
 * roles read FRESH from Discord (not the page's cache), then the approver role. The actor handed
 * to core carries those roles, so core re-checks them too. Form fields claiming roles are ignored.
 */
export async function actionAccess(
  kit: DashboardKit,
  c: Context,
): Promise<{ ok: true; value: CommunityAccess & { actor: PolicyActor; form: Record<string, string> } } | { ok: false; response: Response }> {
  const raw = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const form = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
  const current = await kit.session(c.req.raw)
  if (!current || !sameSecret(form.csrf ?? '', current.session.csrf)) {
    return { ok: false, response: html(messagePage({ title: 'refused', heading: 'That did not come from this dashboard', testnet: kit.testnet, body: '<p>Reload the page and try again.</p>' }), 403) }
  }
  const access = await communityAccess(kit, c, { fresh: true })
  if (!access.ok) return access
  if (!access.value.viewer.canAct) {
    return {
      ok: false,
      response: html(
        messagePage({
          title: 'read only',
          heading: 'Only the Treasurer role can do that',
          testnet: kit.testnet,
          viewer: access.value.viewer,
          body: `<p>You can see this community, read only.</p><p><a href="/dashboard/${access.value.community.id}">Back</a></p>`,
        }),
        403,
      ),
    }
  }
  return { ok: true, value: { ...access.value, actor: { id: access.value.viewer.userId, roleIds: access.value.viewer.roles }, form } }
}
