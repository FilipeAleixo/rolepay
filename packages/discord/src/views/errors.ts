import { type Community, MAX_LINES_PER_RUN, PROPOSAL_LIMITS } from '@rolepay/core'
import { escapeMarkdown, mention, money, relativeTime, roleMention, tokenLabel } from './format.js'

const tokenList = (tokens: unknown) => (Array.isArray(tokens) ? tokens.map((t) => tokenLabel(String(t))).join(' and ') : '?')

export const AI_NOT_CONFIGURED = 'AI proposals are not set up on this Rolepay server: it has no Anthropic API key. Create the run with `/rolepay new` instead.'
export const AI_OFF = 'AI proposals are off in this server. A member with the approver role turns them on with `/rolepay setup ai_proposals:true`.'

export const proposerOnly = (c: Pick<Community, 'approverRoleId' | 'proposerRoleId'>) =>
  c.approverRoleId
    ? `Only members with ${roleMention(c.approverRoleId)}${c.proposerRoleId ? ` or ${roleMention(c.proposerRoleId)}` : ''} can propose pay runs with AI.`
    : 'No approver role is set, so nobody can propose pay runs with AI yet. An admin runs `/rolepay setup approver_role:@Treasurer`.'

const COULD_NOT_PROPOSE = {
  refused: 'The AI declined to propose this one. Try rewording the instruction, or create the run with `/rolepay new`. Nothing was created.',
  malformed: 'The AI answered in a form Rolepay could not use. Try again; nothing was created.',
  unavailable: 'The AI service is not reachable right now. Try again in a minute; nothing was created.',
  rejected: 'The AI service refused the request. The person running Rolepay can see why in the server log. Nothing was created.',
  auth: 'The AI service refused the API key. The person running Rolepay checks ANTHROPIC_API_KEY. Nothing was created.',
  daily_cap: 'This Rolepay server has used its AI proposals for today; more are possible after midnight UTC. Create the run with `/rolepay new` instead. Nothing was created.',
} as const

/** Proposal errors in plain English, then everything else as `explainError`. */
export function explainProposalError(error: CodedError, ctx: { token?: string; community?: Pick<Community, 'approverRoleId' | 'proposerRoleId'> } = {}): string {
  switch (error.code) {
    case 'ai_not_configured':
      return AI_NOT_CONFIGURED
    case 'ai_disabled':
      return AI_OFF
    case 'not_permitted':
      return ctx.community ? proposerOnly(ctx.community) : 'Only members with the approver role (or the proposer role) can do that.'
    case 'could_not_propose':
      return String(error.reason) in COULD_NOT_PROPOSE ? COULD_NOT_PROPOSE[error.reason as keyof typeof COULD_NOT_PROPOSE] : COULD_NOT_PROPOSE.malformed
    case 'criteria_unclear':
      return `The AI could not turn that into a filter: ${escapeMarkdown(String(error.problem ?? ''))} Try naming a role, a channel and an amount, or propose from messages with \`/rolepay propose source:#channel\`.`
    case 'criteria_invalid':
      return `The filter the AI wrote does not work: ${escapeMarkdown(((error.issues as string[] | undefined) ?? []).join('; '))}. Try rewording. Nothing was created.`
    case 'cannot_read':
      if (error.reason === 'not_found') return `Rolepay cannot find that in <#${String(error.channelId)}>. Check the channel or the message link.`
      if (error.reason === 'unsupported') return `Discord would not let Rolepay read that in <#${String(error.channelId)}>: pick a text channel or a thread (not a forum or voice channel), and an emoji the server has.`
      return `Rolepay cannot read <#${String(error.channelId)}>: the bot needs View Channel and Read Message History there.`
    case 'source_not_readable':
      return 'You can only propose from a channel you can read yourself (View Channel and Read Message History).'
    case 'no_message_content':
      return 'Rolepay can see those messages but not their text. Turn on the Message Content intent (Developer Portal, Bot), or right-click a message and use Apps > Propose pay run, which needs no intent.'
    case 'source_empty':
      return 'There are no messages to read there in that period.'
    case 'proposal_not_found':
      return `This proposal has expired (they last ${PROPOSAL_LIMITS.ttlSeconds / 3600} hours) or does not exist. Propose again.`
    case 'proposal_closed':
      return error.status === 'discarded' ? 'This proposal was discarded.' : 'A pay run was already created from this proposal.'
    case 'proposal_blocked':
      return 'Fix this proposal with Edit first: it has an amount your instruction does not state, nobody to pay, or more than 50 people.'
    default:
      return explainError(error, ctx)
  }
}

type CodedError = { code: string } & Record<string, unknown>

/**
 * Every expected failure from core, in plain English for the person who clicked.
 * Unknown codes fall through to a generic sentence that still names the code.
 */
export function explainError(error: CodedError, ctx: { token?: string } = {}): string {
  const amount = (v: unknown) => (typeof v === 'bigint' ? (ctx.token ? money(v, ctx.token) : String(v)) : '?')
  switch (error.code) {
    case 'community_not_found':
      return 'This server has not set up Rolepay yet. An admin runs /rolepay setup first.'
    case 'run_not_found':
      return 'There is no pay run with that ID in this server.'
    case 'illegal_state':
      return `This run is ${String(error.status).replace('_', ' ')} and cannot do that now.`
    case 'concurrent_update':
      return 'Someone else changed this run at the same moment. Check /rolepay status.'
    case 'unregistered_payees': {
      const ids = (error.discordUserIds as string[] | undefined) ?? []
      const next = ids.length === 1 ? 'They need to run /payee link first.' : 'Each of them runs /payee link first.'
      return `Not registered to be paid yet: ${ids.map(mention).join(', ')}. ${next}`
    }
    case 'no_lines':
      return 'Nobody to pay. Pick a role or list some users.'
    case 'too_many_lines':
      return `A run can pay at most ${MAX_LINES_PER_RUN} people.`
    case 'duplicate_payee':
      return 'The same person is in the run twice.'
    case 'invalid_input':
      return `That input is not valid: ${((error.issues as string[] | undefined) ?? []).join('; ')}`
    case 'invalid_run':
      return `That run is not valid: ${String(error.message ?? '')}`
    case 'not_permitted':
      return 'Only members with the approver role can approve runs.'
    case 'creator_cannot_approve':
      return 'In this server the person who created a run cannot approve it. Another member with the approver role approves it.'
    case 'not_retryable':
      return 'This run cannot be retried automatically, because money may already have moved. Check the explorer before doing anything else.'
    case 'attempt_may_still_land':
      return `The last payment attempt for this run could still land until ${error.retryAfter instanceof Date ? relativeTime(error.retryAfter) : 'about two minutes from now'}. Try again after that: Rolepay then checks the chain first.`
    case 'chain_shows_payments':
      return 'The chain already shows payments from this run, so Rolepay will not send it again. Check the explorer.'
    case 'no_active_key':
      return 'The bot has no active key for this server. An admin runs /rolepay setup, then the treasury authorises the key.'
    case 'no_bot_key':
      return 'The bot has no key for this server yet. An admin runs /rolepay setup.'
    case 'key_not_authorized':
      return 'The treasury has not authorised the bot key yet.'
    case 'key_revoked':
      return 'The treasury revoked the bot key. Run /rolepay setup to issue a new one.'
    case 'key_expired':
      return `The bot key expired ${relativeTime(Number(error.expiry))}. Run /rolepay setup to issue a new one.`
    case 'key_expires_too_soon':
      return 'The bot key expires within the next two minutes. Run /rolepay setup to issue a new one.'
    case 'insufficient_limit': {
      const resets = typeof error.periodEnd === 'number' ? ` (it resets ${relativeTime(error.periodEnd)})` : ''
      return `This run needs ${amount(error.needed)} but the bot key has ${amount(error.remaining)} left this period${resets}.`
    }
    case 'fee_budget_exhausted':
      return 'The bot key has used up its fee budget.'
    case 'unseal_failed':
      return 'The bot key could not be unsealed on this server. Check ROLEPAY_MASTER_KEY.'
    case 'already_registered':
      return 'This server is already registered.'
    case 'payee_not_found':
      return 'You are not registered to be paid in this server yet. Run /payee link first.'
    case 'token_not_allowed': {
      const choices = ((error.choices as string[] | undefined) ?? []).map(tokenLabel)
      return `This server cannot pay in that token. Choose one of: ${choices.join(', ')}.`
    }
    case 'swap_not_authorized':
      return `The bot key was authorised before preferred stablecoins were turned on, so it cannot swap into ${tokenList(error.tokens)}. The treasurer authorises a new key on the setup page (\`/rolepay setup\`), then Retry.`
    case 'swap_no_route':
      return `Tempo's stablecoin exchange cannot buy ${tokenList([error.token])} right now (no pair, or not enough liquidity). Nothing was signed. Retry later, or ask the people who chose it to pick another stablecoin.`
    case 'swap_over_cap':
      return `Buying ${tokenList([error.token])} now would cost ${amount(error.quoted)}, more than the ${amount(error.max)} this run allows for it. Nothing was signed. Retry when the price is back.`
    case 'swap_limit_low':
      return `The bot key has ${typeof error.remaining === 'bigint' ? money(error.remaining, String(error.token)) : '?'} of its ${tokenList([error.token])} limit left this period, and this run delivers ${typeof error.needed === 'bigint' ? money(error.needed, String(error.token)) : '?'}. Nothing was signed.`
    default:
      return `Something went wrong (${error.code}). Try again in a moment.`
  }
}

/** Policy errors in plain English, then the proposal and general ones (compiling uses criteria mode). */
export function explainPolicyError(error: CodedError, ctx: { token?: string; community?: Pick<Community, 'approverRoleId' | 'proposerRoleId'> } = {}): string {
  const approver = ctx.community?.approverRoleId ? `members with ${roleMention(ctx.community.approverRoleId)}` : 'the approver role'
  switch (error.code) {
    case 'policy_not_found':
      return 'There is no policy with that ID in this server. `/rolepay policy list` shows them.'
    case 'policy_run_not_found':
      return 'That policy run does not exist in this server.'
    case 'not_permitted':
      return `Only ${approver} can approve, pause, resume, switch modes or veto policies.`
    case 'policy_not_draft':
      return `This policy is ${String(error.status)}, not a draft waiting for approval.`
    case 'version_mismatch':
      return `This preview is out of date: the policy is now at version ${String(error.version)}. Run \`/rolepay policy show\` and approve that one.`
    case 'policy_blocked':
      return 'This rule uses an amount your instruction does not state, so it cannot be approved. Write the policy again with the amounts in the instruction.'
    case 'creator_cannot_approve':
      return 'This server requires a separate approver: someone other than the author of the rule approves it or switches its autopilot on.'
    case 'invalid_veto_window':
      return `The veto window must be between ${String(error.min)} minutes and ${Number(error.max) / 60} hours.`
    case 'policy_not_approved':
      return 'Approve the policy first; autopilot is switched on for an approved policy.'
    case 'policy_archived':
      return 'This policy is archived. It never runs again.'
    case 'policy_not_active':
      return `This policy is not active${error.status ? ` (it is ${String(error.status)})` : ''}.`
    case 'policy_not_paused':
      return `This policy is not paused (it is ${String(error.status)}).`
    case 'not_scheduled':
      return error.status === 'vetoed' ? 'This run was already vetoed.' : `Too late to veto: this run is already ${String(error.status)}.`
    case 'too_late':
      return `Too late to veto: the run is already ${String(error.status).replace('_', ' ')}.`
    case 'already_run':
      return "This policy's next run has already been made."
    case 'discord_not_configured':
      return 'This Rolepay server cannot read Discord activity, so it cannot show who a policy applies to.'
    case 'schedule_not_allowed':
      return 'A daily schedule is a demo control (ROLEPAY_DEMO_CONTROLS=true on Moderato); it is off on this server. Use a weekly or monthly schedule.'
    default:
      return explainProposalError(error, ctx)
  }
}
