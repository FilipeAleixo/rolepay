import { ResponseType } from '../api.js'
import { exportCommand } from '../commands/export.js'
import { newRunCommand } from '../commands/newRun.js'
import { payeeLinkCommand } from '../commands/payeeLink.js'
import { proposeCommand } from '../commands/propose.js'
import { PROPOSE_MESSAGE_COMMAND, proposeFromMessageCommand } from '../commands/proposeFromMessage.js'
import { runChoices } from '../commands/runChoices.js'
import { setupCommand } from '../commands/setup.js'
import { statusCommand } from '../commands/status.js'
import { type ProposalAction, type ProposalModal, type RunAction, decodeCustomId, decodeProposalId, decodeProposalModalId } from '../components/customId.js'
import { createProposalRunButton, discardProposalButton, editProposalButton } from '../components/proposalButtons.js'
import { editModalSubmit, instructionModalSubmit } from '../components/proposalModals.js'
import { approveButton, cancelButton, retryButton } from '../components/runButtons.js'
import type { Dispatch, InteractionLabel } from '../http/handler.js'
import type { DiscordAppDeps } from './deps.js'
import type { AutocompleteHandler, ButtonHandler, CommandHandler, GuildContext, MessageCommandHandler, ModalHandler, ProposalButtonHandler } from './handlers.js'
import { type ParsedInteraction, parseInteraction } from './interaction.js'
import { type Outcome, ephemeralReply, renderLate, renderOutcome } from './outcome.js'

/** `${command} ${subcommand}` -> handler. Kept in step with COMMAND_DEFINITIONS by a test. */
const COMMANDS: Record<string, CommandHandler> = {
  'rolepay setup': setupCommand,
  'rolepay new': newRunCommand,
  'rolepay status': statusCommand,
  'rolepay export': exportCommand,
  'rolepay propose': proposeCommand,
  'payee link': payeeLinkCommand,
}

/** Right-click commands on a message, by their registered name. Kept in step with COMMAND_DEFINITIONS by a test. */
const MESSAGE_COMMANDS: Record<string, MessageCommandHandler> = { [PROPOSE_MESSAGE_COMMAND]: proposeFromMessageCommand }

const AUTOCOMPLETE: Record<string, AutocompleteHandler> = { 'rolepay status': runChoices, 'rolepay export': runChoices }

const BUTTONS: Record<RunAction, ButtonHandler> = { approve: approveButton, cancel: cancelButton, retry: retryButton }
const PROPOSAL_BUTTONS: Record<ProposalAction, ProposalButtonHandler> = { create: createProposalRunButton, edit: editProposalButton, discard: discardProposalButton }
const MODALS: Record<ProposalModal, ModalHandler> = { instruct: instructionModalSubmit, edit: editModalSubmit }

export const ROUTED_COMMANDS = Object.keys(COMMANDS)
export const ROUTED_MESSAGE_COMMANDS = Object.keys(MESSAGE_COMMANDS)

const GENERIC_FAILURE = 'Something went wrong on our side. Nothing was paid by this action; try again in a moment.'
const NO_CHOICES: Outcome = { kind: 'choices', choices: [] }

/**
 * Discord shows "This interaction failed" when the first answer takes more than 3 seconds. A handler
 * not done by this deadline (a slow chain or Discord read, the model, a cold path) is acknowledged
 * with a deferred response, and its answer is delivered by an edit or a follow-up when it is ready.
 */
export const ACK_DEADLINE_MS = 1500

/**
 * The interaction router: parse, route to a handler, render its outcome. Handlers are
 * thin: they parse input, check permissions, call one core service and return a view.
 */
export function createDispatcher(deps: DiscordAppDeps, opts: { ackDeadlineMs?: number } = {}): Dispatch {
  const deadlineMs = opts.ackDeadlineMs ?? ACK_DEADLINE_MS
  return async (raw) => {
    const parsed = parseInteraction(raw)
    if (!parsed.ok) return { kind: 'invalid', reason: parsed.error.detail }
    const interaction = parsed.value
    if (interaction.kind === 'ping') return { kind: 'respond', body: { type: ResponseType.Pong }, label: { kind: 'ping', name: '' } }

    let failed = false
    const pending = route(interaction, deps).catch((error): Outcome => {
      deps.onError?.(error)
      failed = true
      return interaction.kind === 'autocomplete' ? NO_CHOICES : ephemeralReply(GENERIC_FAILURE)
    })
    const label = labelOf(interaction)
    const outcome = await within(pending, deadlineMs)
    if (outcome) return { ...renderOutcome(outcome, interaction.ctx, deps.rest, deps.onError), label, failed }
    // Too slow for Discord's 3 seconds: acknowledge now, deliver the answer when it is ready.
    if (interaction.kind === 'autocomplete') return { ...renderOutcome(NO_CHOICES, interaction.ctx, deps.rest), label, late: true }
    const ack = interaction.kind === 'component' || (interaction.kind === 'modal' && interaction.messageId) ? 'update' : 'reply'
    return { ...renderLate(pending, ack, interaction.ctx, deps.rest, deps.onError), label, late: true }
  }
}

/** The value if it settles within `ms`, else null. The timer never outlives the race. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** For the log: the command, button or form name, never its options, IDs or text. */
function labelOf(i: Exclude<ParsedInteraction, { kind: 'ping' }>): InteractionLabel {
  switch (i.kind) {
    case 'command':
    case 'autocomplete':
      return { kind: i.kind, name: i.sub ? `${i.command} ${i.sub}` : i.command }
    case 'message_command':
      return { kind: i.kind, name: i.command }
    case 'component':
    case 'modal':
      // `rolepay:approve:<runId>` -> `rolepay:approve`
      return { kind: i.kind, name: i.customId.split(':').slice(0, 2).join(':') }
  }
}

async function route(i: Exclude<ParsedInteraction, { kind: 'ping' }>, deps: DiscordAppDeps): Promise<Outcome> {
  if (i.ctx.guildId === null) return ephemeralReply('Rolepay works inside a server. Run this command there.')
  const ctx: GuildContext = { ...i.ctx, guildId: i.ctx.guildId }

  switch (i.kind) {
    case 'command': {
      const handler = COMMANDS[`${i.command} ${i.sub}`]
      return handler ? handler({ options: i.options, ctx, channels: i.channels }, deps) : ephemeralReply('Sorry, I do not know that command. Try /rolepay status.')
    }
    case 'autocomplete': {
      const handler = AUTOCOMPLETE[`${i.command} ${i.sub}`]
      return handler ? handler({ options: i.options, ctx, focused: i.focused }, deps) : { kind: 'choices', choices: [] }
    }
    case 'component': {
      const id = decodeCustomId(i.customId)
      const handler = id && BUTTONS[id.action]
      if (id && handler) return handler({ runId: id.runId, messageId: i.messageId, ctx }, deps)
      const proposal = decodeProposalId(i.customId)
      if (proposal) return PROPOSAL_BUTTONS[proposal.action]({ proposalId: proposal.proposalId, messageId: i.messageId, ctx }, deps)
      return ephemeralReply('Sorry, I do not know that button. It may be from an older version.')
    }
    case 'message_command': {
      const handler = MESSAGE_COMMANDS[i.command]
      return handler ? handler({ target: i.target, ctx }, deps) : ephemeralReply('Sorry, I do not know that command.')
    }
    case 'modal': {
      const modal = decodeProposalModalId(i.customId)
      return modal ? MODALS[modal.modal]({ id: modal.id, fields: i.fields, messageId: i.messageId, ctx }, deps) : ephemeralReply('Sorry, I do not know that form. It may be from an older version.')
    }
  }
}
