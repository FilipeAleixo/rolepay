import { ResponseType } from '../api.js'
import { exportCommand } from '../commands/export.js'
import { newRunCommand } from '../commands/newRun.js'
import { payeeLinkCommand } from '../commands/payeeLink.js'
import {
  policyChoices,
  policyListCommand,
  policyModeCommand,
  policyNewCommand,
  policyPauseCommand,
  policyResumeCommand,
  policyRunNowCommand,
  policyShowCommand,
} from '../commands/policy.js'
import { proposeCommand } from '../commands/propose.js'
import { PROPOSE_MESSAGE_COMMAND, proposeFromMessageCommand } from '../commands/proposeFromMessage.js'
import { runChoices } from '../commands/runChoices.js'
import { setupCommand } from '../commands/setup.js'
import { statusCommand } from '../commands/status.js'
import {
  type PolicyAction,
  type ProposalAction,
  type ProposalModal,
  type RunAction,
  decodeCustomId,
  decodePolicyButton,
  decodeProposalId,
  decodeProposalModalId,
  decodeVetoButton,
} from '../components/customId.js'
import { approvePolicyButton, discardPolicyButton, vetoButton } from '../components/policyButtons.js'
import { createProposalRunButton, discardProposalButton, editProposalButton } from '../components/proposalButtons.js'
import { editModalSubmit, instructionModalSubmit } from '../components/proposalModals.js'
import { approveButton, cancelButton, retryButton } from '../components/runButtons.js'
import type { Dispatch } from '../http/handler.js'
import type { DiscordAppDeps } from './deps.js'
import type { AutocompleteHandler, ButtonHandler, CommandHandler, GuildContext, MessageCommandHandler, ModalHandler, PolicyButtonHandler, ProposalButtonHandler } from './handlers.js'
import { type ParsedInteraction, parseInteraction } from './interaction.js'
import { type Outcome, ephemeralReply, renderOutcome } from './outcome.js'

/** `${command} ${subcommand}` -> handler. Kept in step with COMMAND_DEFINITIONS by a test. */
const COMMANDS: Record<string, CommandHandler> = {
  'rolepay setup': setupCommand,
  'rolepay new': newRunCommand,
  'rolepay status': statusCommand,
  'rolepay export': exportCommand,
  'rolepay propose': proposeCommand,
  'rolepay policy new': policyNewCommand,
  'rolepay policy list': policyListCommand,
  'rolepay policy show': policyShowCommand,
  'rolepay policy pause': policyPauseCommand,
  'rolepay policy resume': policyResumeCommand,
  'rolepay policy mode': policyModeCommand,
  /** Demo control; registered only with ROLEPAY_DEMO_CONTROLS on Moderato, refused otherwise. */
  'rolepay policy run_now': policyRunNowCommand,
  'payee link': payeeLinkCommand,
}

/** Right-click commands on a message, by their registered name. Kept in step with COMMAND_DEFINITIONS by a test. */
const MESSAGE_COMMANDS: Record<string, MessageCommandHandler> = { [PROPOSE_MESSAGE_COMMAND]: proposeFromMessageCommand }

const AUTOCOMPLETE: Record<string, AutocompleteHandler> = {
  'rolepay status': runChoices,
  'rolepay export': runChoices,
  'rolepay policy show': policyChoices,
  'rolepay policy pause': policyChoices,
  'rolepay policy resume': policyChoices,
  'rolepay policy mode': policyChoices,
  'rolepay policy run_now': policyChoices,
}

const BUTTONS: Record<RunAction, ButtonHandler> = { approve: approveButton, cancel: cancelButton, retry: retryButton }
const PROPOSAL_BUTTONS: Record<ProposalAction, ProposalButtonHandler> = { create: createProposalRunButton, edit: editProposalButton, discard: discardProposalButton }
const MODALS: Record<ProposalModal, ModalHandler> = { instruct: instructionModalSubmit, edit: editModalSubmit }
const POLICY_BUTTONS: Record<PolicyAction, PolicyButtonHandler> = { approve: approvePolicyButton, discard: discardPolicyButton }

export const ROUTED_COMMANDS = Object.keys(COMMANDS)
export const ROUTED_MESSAGE_COMMANDS = Object.keys(MESSAGE_COMMANDS)

const GENERIC_FAILURE = 'Something went wrong on our side. Nothing was paid by this action; try again in a moment.'

/**
 * The interaction router: parse, route to a handler, render its outcome. Handlers are
 * thin: they parse input, check permissions, call one core service and return a view.
 */
export function createDispatcher(deps: DiscordAppDeps): Dispatch {
  return async (raw) => {
    const parsed = parseInteraction(raw)
    if (!parsed.ok) return { kind: 'invalid', reason: parsed.error.detail }
    const interaction = parsed.value
    if (interaction.kind === 'ping') return { kind: 'respond', body: { type: ResponseType.Pong } }

    let outcome: Outcome
    try {
      outcome = await route(interaction, deps)
    } catch (error) {
      deps.onError?.(error)
      outcome = interaction.kind === 'autocomplete' ? { kind: 'choices', choices: [] } : ephemeralReply(GENERIC_FAILURE)
    }
    return renderOutcome(outcome, interaction.ctx, deps.rest, deps.onError)
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
      const policy = decodePolicyButton(i.customId)
      if (policy) return POLICY_BUTTONS[policy.action]({ policyId: policy.policyId, version: policy.version, messageId: i.messageId, ctx }, deps)
      const veto = decodeVetoButton(i.customId)
      if (veto) return vetoButton({ policyRunId: veto.policyRunId, messageId: i.messageId, ctx }, deps)
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
