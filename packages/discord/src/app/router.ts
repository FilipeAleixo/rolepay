import { ResponseType } from '../api.js'
import { exportCommand } from '../commands/export.js'
import { newRunCommand } from '../commands/newRun.js'
import { payeeLinkCommand } from '../commands/payeeLink.js'
import { runChoices } from '../commands/runChoices.js'
import { setupCommand } from '../commands/setup.js'
import { statusCommand } from '../commands/status.js'
import { type RunAction, decodeCustomId } from '../components/customId.js'
import { approveButton, cancelButton, retryButton } from '../components/runButtons.js'
import type { Dispatch } from '../http/handler.js'
import type { DiscordAppDeps } from './deps.js'
import type { AutocompleteHandler, ButtonHandler, CommandHandler, GuildContext } from './handlers.js'
import { type ParsedInteraction, parseInteraction } from './interaction.js'
import { type Outcome, ephemeralReply, renderOutcome } from './outcome.js'

/** `${command} ${subcommand}` -> handler. Kept in step with COMMAND_DEFINITIONS by a test. */
const COMMANDS: Record<string, CommandHandler> = {
  'payrun setup': setupCommand,
  'payrun new': newRunCommand,
  'payrun status': statusCommand,
  'payrun export': exportCommand,
  'payee link': payeeLinkCommand,
}

const AUTOCOMPLETE: Record<string, AutocompleteHandler> = { 'payrun status': runChoices, 'payrun export': runChoices }

const BUTTONS: Record<RunAction, ButtonHandler> = { approve: approveButton, cancel: cancelButton, retry: retryButton }

export const ROUTED_COMMANDS = Object.keys(COMMANDS)

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
  if (i.ctx.guildId === null) return ephemeralReply('payrun works inside a server. Run this command there.')
  const ctx: GuildContext = { ...i.ctx, guildId: i.ctx.guildId }

  switch (i.kind) {
    case 'command': {
      const handler = COMMANDS[`${i.command} ${i.sub}`]
      return handler ? handler({ options: i.options, ctx }, deps) : ephemeralReply('Sorry, I do not know that command. Try /payrun status.')
    }
    case 'autocomplete': {
      const handler = AUTOCOMPLETE[`${i.command} ${i.sub}`]
      return handler ? handler({ options: i.options, ctx, focused: i.focused }, deps) : { kind: 'choices', choices: [] }
    }
    case 'component': {
      const id = decodeCustomId(i.customId)
      const handler = id && BUTTONS[id.action]
      return id && handler ? handler({ runId: id.runId, ctx }, deps) : ephemeralReply('Sorry, I do not know that button. It may be from an older version.')
    }
  }
}
