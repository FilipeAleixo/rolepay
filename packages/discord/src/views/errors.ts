import { MAX_LINES_PER_RUN } from '@payrun/core'
import { mention, money, relativeTime } from './format.js'

type CodedError = { code: string } & Record<string, unknown>

/**
 * Every expected failure from core, in plain English for the person who clicked.
 * Unknown codes fall through to a generic sentence that still names the code.
 */
export function explainError(error: CodedError, ctx: { token?: string } = {}): string {
  const amount = (v: unknown) => (typeof v === 'bigint' ? (ctx.token ? money(v, ctx.token) : String(v)) : '?')
  switch (error.code) {
    case 'community_not_found':
      return 'This server has not set up payrun yet. An admin runs /payrun setup first.'
    case 'run_not_found':
      return 'There is no pay run with that ID in this server.'
    case 'illegal_state':
      return `This run is ${String(error.status).replace('_', ' ')} and cannot do that now.`
    case 'concurrent_update':
      return 'Someone else changed this run at the same moment. Check /payrun status.'
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
      return `The last payment attempt for this run could still land until ${error.retryAfter instanceof Date ? relativeTime(error.retryAfter) : 'about two minutes from now'}. Try again after that: payrun then checks the chain first.`
    case 'chain_shows_payments':
      return 'The chain already shows payments from this run, so payrun will not send it again. Check the explorer.'
    case 'no_active_key':
      return 'The bot has no active key for this server. An admin runs /payrun setup, then the treasury authorises the key.'
    case 'no_bot_key':
      return 'The bot has no key for this server yet. An admin runs /payrun setup.'
    case 'key_not_authorized':
      return 'The treasury has not authorised the bot key yet.'
    case 'key_revoked':
      return 'The treasury revoked the bot key. Run /payrun setup to issue a new one.'
    case 'key_expired':
      return `The bot key expired ${relativeTime(Number(error.expiry))}. Run /payrun setup to issue a new one.`
    case 'key_expires_too_soon':
      return 'The bot key expires within the next two minutes. Run /payrun setup to issue a new one.'
    case 'insufficient_limit': {
      const resets = typeof error.periodEnd === 'number' ? ` (it resets ${relativeTime(error.periodEnd)})` : ''
      return `This run needs ${amount(error.needed)} but the bot key has ${amount(error.remaining)} left this period${resets}.`
    }
    case 'fee_budget_exhausted':
      return 'The bot key has used up its fee budget.'
    case 'unseal_failed':
      return 'The bot key could not be unsealed on this server. Check PAYRUN_MASTER_KEY.'
    case 'already_registered':
      return 'This server is already registered.'
    default:
      return `Something went wrong (${error.code}). Try again in a moment.`
  }
}
