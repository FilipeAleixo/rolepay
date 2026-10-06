import { type Message, MessageFlags, type Modal, ResponseType, splitFiles } from '../api.js'
import type { Dispatched } from '../http/handler.js'
import type { DiscordRest } from '../ports.js'
import type { InteractionContext } from './interaction.js'

export type Choice = { name: string; value: string }

/** A deferred job's result: the message to show, or an error for the caller only. */
export type DeferredResult = { ok: true; message: Message } | { ok: false; message: Message }

/** What a handler decides. Handlers never talk to Discord directly; this is rendered for them. */
export type Outcome =
  | { kind: 'reply'; message: Message; ephemeral: boolean }
  /** For a button (or a modal a button opened): replace the message it is on; `followUp` then posts a new message. */
  | { kind: 'update'; message: Message; followUp?: Message }
  /** Show a form. Only as the answer to a command or a button. */
  | { kind: 'modal'; modal: Modal }
  /** Answer now ("thinking…"), finish in the background, then edit the reply. For anything slower than 3 s. */
  | { kind: 'defer'; ephemeral: boolean; work: () => Promise<DeferredResult> }
  | { kind: 'choices'; choices: Choice[] }

export const ephemeralReply = (content: string): Outcome => ({ kind: 'reply', ephemeral: true, message: { content } })

const GENERIC_FAILURE = 'Something went wrong on our side. Nothing was paid by this action; try again in a moment.'

export function renderOutcome(outcome: Outcome, ctx: InteractionContext, rest: DiscordRest, onError?: (e: unknown) => void): Dispatched {
  switch (outcome.kind) {
    case 'reply': {
      const { json, files } = splitFiles(outcome.message)
      const data = outcome.ephemeral ? { ...json, flags: (json.flags ?? 0) | MessageFlags.Ephemeral } : json
      return { kind: 'respond', body: { type: ResponseType.ChannelMessage, data }, ...(files.length ? { files } : {}) }
    }
    case 'update': {
      const body = { type: ResponseType.UpdateMessage, data: splitFiles(outcome.message).json }
      const followUp = outcome.followUp
      if (!followUp) return { kind: 'respond', body }
      const reply = { applicationId: ctx.applicationId, token: ctx.token }
      return {
        kind: 'respond',
        body,
        background: async () => {
          const posted = await rest.followUp(reply, followUp)
          // The interaction token is fresh here; if the follow-up still fails, post in the channel as the bot.
          if (!posted.ok && ctx.channelId) await rest.postToChannel(ctx.channelId, followUp)
        },
      }
    }
    case 'modal':
      return { kind: 'respond', body: { type: ResponseType.Modal, data: outcome.modal } }
    case 'choices':
      return { kind: 'respond', body: { type: ResponseType.AutocompleteResult, data: { choices: outcome.choices.slice(0, 25) } } }
    case 'defer': {
      const reply = { applicationId: ctx.applicationId, token: ctx.token }
      const background = async () => {
        let result: DeferredResult
        try {
          result = await outcome.work()
        } catch (e) {
          onError?.(e)
          result = { ok: false, message: { content: GENERIC_FAILURE } }
        }
        if (result.ok || outcome.ephemeral) {
          await rest.editOriginal(reply, result.message)
          return
        }
        // A public placeholder must not turn into a public error: remove it, tell only the caller.
        await rest.deleteOriginal(reply)
        await rest.followUp(reply, { ...result.message, flags: (result.message.flags ?? 0) | MessageFlags.Ephemeral })
      }
      return {
        kind: 'respond',
        body: { type: ResponseType.DeferredChannelMessage, data: outcome.ephemeral ? { flags: MessageFlags.Ephemeral } : {} },
        background,
      }
    }
  }
}
