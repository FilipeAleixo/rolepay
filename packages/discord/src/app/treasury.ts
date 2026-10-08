import { type Community, DiscordIdSchema, type Policy, type Rolepay, findTreasuryChannel, mayFindTreasuryChannel, nextOccurrence } from '@rolepay/core'
import { z } from 'zod'
import { ChannelType, type Message, Permission } from '../api.js'
import type { DiscordRest, PolicyPreviewMessages, RestError, RestResult, RunMessageRef, RunNotices } from '../ports.js'
import { policyDiscardedMessage, policyMessage, policyReplacedMessage } from '../views/policy.js'
import { policySentToTreasurers, sentToTreasurers, treasuryChannelConfirmation } from '../views/treasury.js'
import type { DiscordAppDeps } from './deps.js'
import type { MirrorEdit } from './outcome.js'

/**
 * The treasury channel in Discord: where what only a Treasurer can act on is posted (policies and
 * runs to approve, runs to veto, held runs), with its buttons, while the channel it would have gone
 * to gets a copy without them. Shared by the policy notifier, the executor, the recovery sweep, the
 * commands that make a run or a policy, and the dashboard's policy actions. Without a treasury channel
 * nothing here posts anything, and every caller does what it always did: one message, with its
 * buttons, where it always went.
 */

/** For the server's log: Rolepay found #treasury, or could not post in the treasury channel (the message went where it always did). */
export type TreasuryEvent =
  | { kind: 'found'; guildId: string; channelId: string; replaced: string | null }
  | { kind: 'unavailable'; guildId: string; channelId: string; reason: RestError['code'] }

export type TreasuryDeps = {
  rolepay: Rolepay
  rest: DiscordRest
  notices: RunNotices
  onTreasury?: (event: TreasuryEvent) => void
  onError?: (error: unknown) => void
}

/** A server's text channel, as the treasury channel setting offers it. */
export type TextChannel = { id: string; name: string; everyoneCanView: boolean }

const OverwriteSchema = z.object({ id: z.string(), allow: z.string().default('0'), deny: z.string().default('0') })
const GuildChannelSchema = z.object({
  id: DiscordIdSchema,
  name: z.string().nullable().optional(),
  type: z.number().int(),
  position: z.number().int().optional(),
  parent_id: DiscordIdSchema.nullable().optional(),
  permission_overwrites: z.array(OverwriteSchema).optional(),
})
const RoleSchema = z.object({ id: z.string(), permissions: z.string() })

const bits = (s: string) => (/^\d{1,40}$/.test(s) ? BigInt(s) : 0n)

/**
 * The server's text channels (no categories, voice channels, forums or threads), in the order Discord
 * shows them, each with whether @everyone can see it: the @everyone role's own permissions (its ID is
 * the server's) with the channel's overwrite for that role applied. A channel synced to its category
 * carries the category's overwrites itself. null when Discord does not answer. The roles are read only
 * with `visibility` (the dashboard's warning); without it every channel counts as visible.
 */
export async function readTextChannels(rest: Pick<DiscordRest, 'getGuildChannels' | 'getGuildRoles'>, guildId: string, opts: { visibility?: boolean } = {}): Promise<TextChannel[] | null> {
  const [channels, roles] = await Promise.all([rest.getGuildChannels(guildId), opts.visibility ? rest.getGuildRoles(guildId) : null])
  if (!channels.ok || !Array.isArray(channels.value)) return null
  const all = channels.value.flatMap((raw) => {
    const c = GuildChannelSchema.safeParse(raw)
    return c.success ? [c.data] : []
  })
  const everyone = roles?.ok && Array.isArray(roles.value) ? roles.value.flatMap((r) => (RoleSchema.safeParse(r).success ? [RoleSchema.parse(r)] : [])).find((r) => r.id === guildId) : undefined
  // Discord's default: @everyone may view channels unless the server took it away.
  const base = everyone ? bits(everyone.permissions) : Permission.ViewChannel
  const visible = (c: z.infer<typeof GuildChannelSchema>) => {
    if ((base & Permission.Administrator) !== 0n) return true
    const o = c.permission_overwrites?.find((x) => x.id === guildId)
    const perms = o ? (base & ~bits(o.deny)) | bits(o.allow) : base
    return (perms & Permission.ViewChannel) !== 0n
  }
  const categories = new Map(all.filter((c) => c.type === ChannelType.Category).map((c) => [c.id, c.position ?? 0]))
  const order = (c: z.infer<typeof GuildChannelSchema>) => [c.parent_id ? (categories.get(c.parent_id) ?? 0) : -1, c.position ?? 0] as const
  return all
    .filter((c) => c.type === ChannelType.Text && typeof c.name === 'string')
    .sort((a, b) => {
      const [pa, qa] = order(a)
      const [pb, qb] = order(b)
      return pa - pb || qa - qb || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)
    })
    .map((c) => ({ id: c.id, name: c.name as string, everyoneCanView: visible(c) }))
}

/** Posts Rolepay's confirmation in a channel about to become the treasury channel: it says what goes there, and proves Rolepay can post there. */
export const confirmTreasuryChannel = (rest: Pick<DiscordRest, 'postToChannel'>, channelId: string): Promise<RestResult> => rest.postToChannel(channelId, treasuryChannelConfirmation())

/**
 * Looks for a text channel named "treasury" while Rolepay may (nobody chose a channel, or the one set
 * is gone: `replacing`), posts the confirmation there and takes it as the treasury channel, audited.
 * The channel to use now, or null: none found, Rolepay cannot post there, or a Treasurer chose none
 * meanwhile (their choice always wins). Never throws: a failure only means no treasury channel this time.
 */
export async function lookForTreasuryChannel(deps: TreasuryDeps, community: Community, replacing: string | null): Promise<string | null> {
  if (!mayFindTreasuryChannel(community, replacing)) return null
  try {
    const channels = await readTextChannels(deps.rest, community.id)
    const found = channels && findTreasuryChannel(channels.filter((c) => c.id !== replacing))
    if (!found || !(await confirmTreasuryChannel(deps.rest, found.id)).ok) return null
    const taken = await deps.rolepay.communities.useFoundTreasuryChannel({ guildId: community.id, channelId: found.id, replacing })
    if (taken.ok) {
      deps.onTreasury?.({ kind: 'found', guildId: community.id, channelId: found.id, replaced: replacing })
      return found.id
    }
    // Someone else decided first (a Treasurer, or another instance that found it too): theirs stands.
    const now = await deps.rolepay.communities.get(community.id)
    return now.ok ? now.value.treasuryChannelId : null
  } catch (error) {
    deps.onError?.(error)
    return null
  }
}

/**
 * Posts a message only a Treasurer can act on in the treasury channel: the one set, or a channel named
 * "treasury" Rolepay finds now. When the one set refuses it (deleted, or Rolepay lost access) that is
 * reported, and the lookup tries once more. null: no treasury channel apart from `channelId` (the
 * channel the message would have gone to anyway), so the caller posts it there, buttons included, as it
 * always did, and nothing is lost.
 */
export async function postForTreasurer(deps: TreasuryDeps, community: Community, message: Message, channelId: string | null): Promise<RunMessageRef | null> {
  let treasury = community.treasuryChannelId ?? (await lookForTreasuryChannel(deps, community, null))
  for (let attempt = 0; treasury && treasury !== channelId; attempt++) {
    const posted = await deps.rest.postMessage(treasury, message)
    if (posted.ok) return { channelId: treasury, messageId: posted.value.messageId }
    deps.onTreasury?.({ kind: 'unavailable', guildId: community.id, channelId: treasury, reason: posted.error.code })
    const gone = posted.error.code === 'forbidden' || posted.error.code === 'not_found'
    if (attempt > 0 || !gone) return null
    treasury = await lookForTreasuryChannel(deps, community, treasury)
  }
  return null
}

/**
 * A run that waits for a Treasurer (to approve, or to veto), posted for the first time. With a treasury
 * channel: the message with the buttons there and its copy without them in `channelId` (when there is
 * one), both remembered, so every later update reaches both. `routed: false`: there is no treasury
 * channel to post in, nothing was posted, and the caller posts the message where it always did.
 * `mirror` null: the copy could not be posted (the caller may show it another way).
 */
export async function postRunForTreasurer(
  deps: TreasuryDeps,
  input: { community: Community; runId: string; view: (mirror: boolean) => Message; channelId: string | null },
): Promise<{ routed: false } | { routed: true; mirror: RunMessageRef | null }> {
  const treasury = await postForTreasurer(deps, input.community, input.view(false), input.channelId)
  if (!treasury) return { routed: false }
  await deps.notices.rememberMessage(input.runId, treasury)
  if (!input.channelId) return { routed: true, mirror: null }
  const posted = await deps.rest.postMessage(input.channelId, input.view(true))
  if (!posted.ok) return { routed: true, mirror: null }
  const mirror = { channelId: input.channelId, messageId: posted.value.messageId }
  await deps.notices.rememberMirror(input.runId, mirror)
  return { routed: true, mirror }
}

/**
 * A run just made from an interaction (/rolepay new, the pay form, Create pay run), waiting for a
 * Treasurer: what the interaction answers. With a treasury channel, the message with Approve goes
 * there and its copy without buttons into `channelId` (where the command ran), both as Rolepay's own
 * messages so later updates reach them, and the caller alone is told (`privately`). If Rolepay cannot
 * post the copy here, the answer is the copy (it is then not updated later). Without a treasury
 * channel, or without `notices` to keep the two in step: the review with its buttons, as always.
 */
export async function answerForNewRun(
  deps: DiscordAppDeps,
  input: { community: Community; runId: string; view: (mirror: boolean) => Message; channelId: string | null },
): Promise<{ message: Message; privately: boolean }> {
  if (!deps.notices) return { message: input.view(false), privately: false }
  const routed = await postRunForTreasurer(treasuryOf(deps, deps.notices), input)
  if (!routed.routed) return { message: input.view(false), privately: false }
  return routed.mirror ? { message: sentToTreasurers(), privately: true } : { message: input.view(true), privately: false }
}

const treasuryOf = (deps: DiscordAppDeps, notices: RunNotices): TreasuryDeps => ({
  rolepay: deps.rolepay,
  rest: deps.rest,
  notices,
  ...(deps.onTreasury ? { onTreasury: deps.onTreasury } : {}),
  ...(deps.onError ? { onError: deps.onError } : {}),
})

/**
 * A policy just written with /rolepay policy new, waiting for a Treasurer: what the command answers.
 * As for a run made from Discord: with a treasury channel, the preview with Approve policy and Discard
 * goes there and its copy without them into `channelId` (where the command was typed), both as
 * Rolepay's own messages, remembered with the version they show so a later approval, discard, edit or
 * archive reaches both, and the author alone is told (`privately`). If Rolepay cannot post the copy
 * here, the answer is the copy (it is then not updated later). If it cannot post in the treasury
 * channel (reported, as for a run), or there is none, or no `notices`: the preview with its buttons.
 */
export async function answerForNewPolicy(
  deps: DiscordAppDeps,
  input: { community: Community; policyId: string; version: number; view: (mirror: boolean) => Message; channelId: string | null },
): Promise<{ message: Message; privately: boolean }> {
  if (!deps.notices) return { message: input.view(false), privately: false }
  const message = await postForTreasurer(treasuryOf(deps, deps.notices), input.community, input.view(false), input.channelId)
  if (!message) return { message: input.view(false), privately: false }
  const posted = input.channelId ? await deps.rest.postMessage(input.channelId, input.view(true)) : null
  const mirror = input.channelId && posted?.ok ? { channelId: input.channelId, messageId: posted.value.messageId } : null
  await deps.notices.rememberPolicyPreview(input.policyId, { version: input.version, message, mirror })
  return mirror ? { message: policySentToTreasurers(), privately: true } : { message: input.view(true), privately: false }
}

type Shown = { ok: true; ref: RunMessageRef } | { ok: false; reason: RestError['code'] }

/** Edits a message where it is, or posts it again in its channel when it cannot be edited: where it is now (the same ref when edited), or why not. */
async function show(rest: DiscordRest, ref: RunMessageRef, message: Message): Promise<Shown> {
  if (ref.messageId && (await rest.editChannelMessage(ref.channelId, ref.messageId, message)).ok) return { ok: true, ref }
  const posted = await rest.postMessage(ref.channelId, message)
  return posted.ok ? { ok: true, ref: { channelId: ref.channelId, messageId: posted.value.messageId } } : { ok: false, reason: posted.error.code }
}

/**
 * Shows a run's new state everywhere it was posted: its message (edited, or posted again in its channel
 * when it cannot be edited; `fallback` when none is remembered) and its copy without buttons, if it has
 * one. When the message in the treasury channel can be neither edited nor posted again (the channel
 * deleted, or Rolepay lost access), the copy takes the buttons over, so a Treasurer can still act.
 */
export async function updateRunMessages(
  deps: Pick<TreasuryDeps, 'rest' | 'notices' | 'onTreasury'>,
  run: { id: string; communityId: string },
  view: (mirror: boolean) => Message,
  fallback: RunMessageRef | null,
): Promise<void> {
  const primary = (await deps.notices.message(run.id)) ?? fallback
  const mirror = await deps.notices.mirror(run.id)
  let shown: Shown | null = null
  if (primary) {
    shown = await show(deps.rest, primary, view(false))
    if (!shown.ok || shown.ref !== primary) await deps.notices.rememberMessage(run.id, shown.ok ? shown.ref : { channelId: primary.channelId, messageId: null })
  }
  if (!mirror) return
  if (shown?.ok) return updateMirror(deps, run.id, view(true))
  if (primary && shown && !shown.ok) deps.onTreasury?.({ kind: 'unavailable', guildId: run.communityId, channelId: primary.channelId, reason: shown.reason })
  const took = await show(deps.rest, mirror, view(false))
  if (!took.ok) return
  await deps.notices.rememberMessage(run.id, took.ref)
  await deps.notices.rememberMirror(run.id, null)
}

/** Shows a run's new state on its copy without buttons, if it has one: edited, or posted again in its channel. */
export async function updateMirror(deps: Pick<TreasuryDeps, 'rest' | 'notices'>, runId: string, message: Message): Promise<void> {
  const mirror = await deps.notices.mirror(runId)
  if (!mirror) return
  const shown = await show(deps.rest, mirror, message)
  if (shown.ok && shown.ref !== mirror) await deps.notices.rememberMirror(runId, shown.ref)
}

/**
 * For a button on a run's message in the treasury channel: the edit of its copy without buttons that
 * goes with the button's own update, so both show the same state at once.
 */
export async function mirrorOf(notices: RunNotices | undefined, runId: string, message: Message): Promise<{ mirrors?: MirrorEdit[] }> {
  const ref = notices ? await notices.mirror(runId) : null
  return ref?.messageId ? { mirrors: [{ channelId: ref.channelId, messageId: ref.messageId, message }] } : {}
}

/**
 * For Approve policy or Discard, pressed for `version`: the edits of that preview's messages with a
 * treasury channel that go with the button's own update. Pressed on its message in the treasury
 * channel, that is the copy; pressed anywhere else (the private answer of `/rolepay policy show`),
 * both. `settled`: the preview is done with (discarded), so its messages are forgotten.
 */
export async function policyMirrorsOf(
  notices: RunNotices | undefined,
  input: { policyId: string; version: number; messageId: string | null; settled: boolean },
  view: (mirror: boolean) => Message,
): Promise<{ mirrors?: MirrorEdit[] }> {
  const shown = notices ? await notices.policyPreview(input.policyId) : null
  if (!notices || !shown || shown.version !== input.version) return {}
  if (input.settled) await notices.rememberPolicyPreview(input.policyId, null)
  const edit = (ref: RunMessageRef | null, mirror: boolean): MirrorEdit[] =>
    ref?.messageId && ref.messageId !== input.messageId ? [{ channelId: ref.channelId, messageId: ref.messageId, message: view(mirror) }] : []
  const mirrors = [...edit(shown.message, false), ...edit(shown.mirror, true)]
  return mirrors.length ? { mirrors } : {}
}

/** A policy changed outside its preview's buttons (on the dashboard), by `by`. */
export type PolicyChange = { guildId: string; policyId: string; kind: 'approved' | 'discarded' | 'edited' | 'archived'; by: string }

/**
 * What a policy preview's messages show after `change`, or null when it does not concern the version
 * they show. `settled`: that version is done with (discarded, replaced or archived), so nothing later
 * reaches these messages; an approved one is kept, so a later edit can say it was replaced.
 */
function previewAfter(p: Policy, shown: number, change: PolicyChange, c: Community, now: Date): { view: (mirror: boolean) => Message; settled: boolean } | null {
  const ctx = { token: c.payoutToken, approverRoleId: c.approverRoleId }
  switch (change.kind) {
    case 'approved':
      // As Approve policy pressed in Discord shows it: who approved it, when, and the next run.
      return p.version === shown && p.status === 'active' ? { view: (mirror) => policyMessage(p, { ...ctx, nextRunAt: nextOccurrence(p.schedule, now), mirror }), settled: false } : null
    case 'discarded':
      // The version shown was dropped: the policy is archived (never approved), or an earlier approved version is back.
      return p.version < shown || (p.version === shown && p.status === 'archived') ? { view: () => policyDiscardedMessage(p, change.by), settled: true } : null
    case 'edited':
      return p.version > shown ? { view: () => policyReplacedMessage(p, shown, change.by), settled: true } : null
    case 'archived':
      return p.status === 'archived' ? { view: (mirror) => policyMessage(p, { ...ctx, mirror }), settled: true } : null
  }
}

/**
 * Shows a policy change made on the dashboard on its preview's messages in Discord, both of them, as
 * the preview's buttons would have (edited, or posted again in their channel when they cannot be
 * edited). Only a preview posted with a treasury channel is remembered, so without one nothing here
 * posts anything. Never throws: a failure is reported, and the change itself stands.
 */
export async function updatePolicyMessages(deps: Pick<TreasuryDeps, 'rolepay' | 'rest' | 'notices' | 'onError'> & { now: () => Date }, change: PolicyChange): Promise<void> {
  try {
    const shown = await deps.notices.policyPreview(change.policyId)
    if (!shown) return
    const [policy, community] = await Promise.all([deps.rolepay.policies.get({ guildId: change.guildId, policyId: change.policyId }), deps.rolepay.communities.get(change.guildId)])
    if (!policy.ok || !community.ok) return
    const next = previewAfter(policy.value, shown.version, change, community.value, deps.now())
    if (!next) return
    const message = await show(deps.rest, shown.message, next.view(false))
    const mirror = shown.mirror ? await show(deps.rest, shown.mirror, next.view(true)) : null
    const kept: PolicyPreviewMessages = { version: shown.version, message: message.ok ? message.ref : shown.message, mirror: mirror?.ok ? mirror.ref : shown.mirror }
    await deps.notices.rememberPolicyPreview(change.policyId, next.settled ? null : kept)
  } catch (error) {
    deps.onError?.(error)
  }
}
