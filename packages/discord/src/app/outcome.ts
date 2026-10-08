import { type Message, MessageFlags, type Modal, ResponseType, splitFiles } from '../api.js'
import type { BackgroundReport, Responded } from '../http/handler.js'
import type { DiscordRest, ReplyHandle } from '../ports.js'
import type { InteractionContext } from './interaction.js'

export type Choice = { name: string; value: string }

/**
 * A deferred job's result: the message to show, or an error for the caller only. `timings`: the
 * job's own phases in milliseconds (Discord reads, the database...), for the log line, never shown.
 */
export type DeferredResult =
  /** `privately`: show it to the caller only, the public placeholder removed (as for an error): the run went out as Rolepay's own messages. */
  | { ok: true; message: Message; timings?: Record<string, number>; privately?: boolean }
  | { ok: false; message: Message; timings?: Record<string, number> }

const sinceMs = (started: number) => Math.round(performance.now() - started)

/** What a handler decides. Handlers never talk to Discord directly; this is rendered for them. */
export type Outcome =
  | { kind: 'reply'; message: Message; ephemeral: boolean }
  /**
   * For a button (or a modal a button opened): replace the message it is on; `followUp` then posts a
   * new message, and `mirror` edits the run's copy without buttons (the button is in the treasury
   * channel), so both show the same state.
   */
  | { kind: 'update'; message: Message; followUp?: Message; mirror?: MirrorEdit }
  /** Show a form. Only as the answer to a command or a button. */
  | { kind: 'modal'; modal: Modal }
  /**
   * Answer now ("thinking…", or `placeholder` when it says better what is happening), finish in the
   * background, then edit the reply. For anything slower than 3 s.
   */
  | { kind: 'defer'; ephemeral: boolean; placeholder?: string; work: () => Promise<DeferredResult> }
  | { kind: 'choices'; choices: Choice[] }

/** The copy of a run, without buttons, in the channel it would have gone to: edited as the bot. */
export type MirrorEdit = { channelId: string; messageId: string; message: Message }

export const ephemeralReply = (content: string): Outcome => ({ kind: 'reply', ephemeral: true, message: { content } })

const GENERIC_FAILURE = 'Something went wrong on our side. Nothing was paid by this action; try again in a moment.'
/** Discord refused the finished answer itself (too long, say): a short message instead of "thinking..." forever. */
const UNSHOWABLE = 'Rolepay could not show this answer in Discord. Nothing was created or paid; try again with a narrower request.'
/** A form can only be the first answer; one ready after the deadline cannot be shown. */
const FORM_TOO_LATE = 'That took too long, so Discord would not open the form. Nothing was changed; try again.'

export function renderOutcome(outcome: Outcome, ctx: InteractionContext, rest: DiscordRest, onError?: (e: unknown) => void): Responded {
  switch (outcome.kind) {
    case 'reply': {
      const { json, files } = splitFiles(outcome.message)
      const data = outcome.ephemeral ? { ...json, flags: (json.flags ?? 0) | MessageFlags.Ephemeral } : json
      return { kind: 'respond', body: { type: ResponseType.ChannelMessage, data }, ...(files.length ? { files } : {}) }
    }
    case 'update': {
      const body = { type: ResponseType.UpdateMessage, data: splitFiles(outcome.message).json }
      const { followUp, mirror } = outcome
      if (!followUp && !mirror) return { kind: 'respond', body }
      return {
        kind: 'respond',
        body,
        background: async () => {
          if (followUp) await postFollowUp(rest, ctx, followUp)
          if (mirror) await editMirror(rest, mirror)
        },
      }
    }
    case 'modal':
      return { kind: 'respond', body: { type: ResponseType.Modal, data: outcome.modal } }
    case 'choices':
      return { kind: 'respond', body: { type: ResponseType.AutocompleteResult, data: { choices: outcome.choices.slice(0, 25) } } }
    case 'defer': {
      const reply = replyTo(ctx)
      const background = async (): Promise<BackgroundReport> => {
        const started = performance.now()
        const result = await finish(outcome.work, onError)
        const work = sinceMs(started)
        const replying = performance.now()
        if ((result.ok && !result.privately) || outcome.ephemeral) {
          await editReply(rest, reply, result.message, onError)
        } else {
          // A public placeholder must not turn into a public error: remove it, tell only the caller.
          await rest.deleteOriginal(reply)
          await rest.followUp(reply, privately(result.message))
        }
        return { phases: { ...result.timings, work, reply: sinceMs(replying) } }
      }
      const flags = outcome.ephemeral ? { flags: MessageFlags.Ephemeral } : {}
      const body = outcome.placeholder
        ? { type: ResponseType.ChannelMessage, data: { content: outcome.placeholder, ...flags } }
        : { type: ResponseType.DeferredChannelMessage, data: flags }
      return { kind: 'respond', body, background }
    }
  }
}

/**
 * The answer to an interaction whose handler missed the deadline, so Discord does not show "This
 * interaction failed": acknowledge now, deliver the outcome when it is ready. `update` (a button,
 * or a form a button opened) acknowledges without changing the message (type 6), then edits it or
 * follows up; `reply` (a command) acknowledges with a private "thinking…" (type 5) and edits it in,
 * or, for an answer meant for everyone, posts it in the channel. Autocomplete cannot be deferred:
 * the router answers it with no choices instead.
 */
export function renderLate(
  pending: Promise<Outcome>,
  ack: 'update' | 'reply',
  ctx: InteractionContext,
  rest: DiscordRest,
  onError?: (e: unknown) => void,
): Responded {
  const reply = replyTo(ctx)
  const show = async (message: Message, ephemeral: boolean) => {
    if (ack === 'update') {
      // A private answer is never posted in the channel instead, even if the follow-up fails.
      if (ephemeral) return void (await rest.followUp(reply, privately(message)))
      return postFollowUp(rest, ctx, message)
    }
    if (ephemeral || !ctx.channelId) return editReply(rest, reply, message, onError)
    // The acknowledgement was private but this answer is for everyone (a run review): post it in the channel as the bot.
    const posted = await rest.postToChannel(ctx.channelId, message)
    if (!posted.ok) return editReply(rest, reply, message, onError)
    await rest.deleteOriginal(reply)
  }
  /** Waits for the handler (and its deferred work), then says what to deliver; the timings are the work's own. */
  const ready = async (): Promise<{ deliver: () => Promise<void>; timings?: Record<string, number> }> => {
    const outcome = await pending
    switch (outcome.kind) {
      case 'reply':
        return { deliver: () => show(outcome.message, outcome.ephemeral) }
      case 'update':
        return {
          deliver: async () => {
            await editReply(rest, reply, outcome.message, onError)
            if (ack === 'update' && outcome.followUp) await postFollowUp(rest, ctx, outcome.followUp)
            if (outcome.mirror) await editMirror(rest, outcome.mirror)
          },
        }
      case 'defer': {
        const result = await finish(outcome.work, onError)
        return { deliver: () => show(result.message, outcome.ephemeral || !result.ok || result.privately === true), ...(result.timings ? { timings: result.timings } : {}) }
      }
      case 'modal':
        return { deliver: () => show({ content: FORM_TOO_LATE }, true) }
      case 'choices':
        return { deliver: async () => {} }
    }
  }
  const background = async (): Promise<BackgroundReport> => {
    const started = performance.now()
    const { deliver, timings } = await ready()
    const work = sinceMs(started)
    const replying = performance.now()
    await deliver()
    return { phases: { ...timings, work, reply: sinceMs(replying) } }
  }
  const body = ack === 'update' ? { type: ResponseType.DeferredUpdateMessage } : { type: ResponseType.DeferredChannelMessage, data: { flags: MessageFlags.Ephemeral } }
  return { kind: 'respond', body, background }
}

const replyTo = (ctx: InteractionContext): ReplyHandle => ({ applicationId: ctx.applicationId, token: ctx.token })
const privately = (message: Message): Message => ({ ...message, flags: (message.flags ?? 0) | MessageFlags.Ephemeral })

/** Deferred work's result; a throw becomes the generic apology (and is reported), never a spinner forever. */
async function finish(work: () => Promise<DeferredResult>, onError?: (e: unknown) => void): Promise<DeferredResult> {
  try {
    return await work()
  } catch (e) {
    onError?.(e)
    return { ok: false, message: { content: GENERIC_FAILURE } }
  }
}

/** Edits the reply; if Discord refuses the answer itself (too long, say), a short message replaces it. */
async function editReply(rest: DiscordRest, reply: ReplyHandle, message: Message, onError?: (e: unknown) => void): Promise<void> {
  const edited = await rest.editOriginal(reply, message)
  if (!edited.ok && edited.error.code === 'http_error') {
    onError?.(new Error(`Discord refused the reply edit: HTTP ${edited.error.status}`))
    await rest.editOriginal(reply, { content: UNSHOWABLE })
  }
}

/**
 * A new message through the interaction; if that fails (the token is fresh, so rarely), posted in
 * the channel as the bot. A private one (a treasury page link) is never posted in the channel.
 */
async function postFollowUp(rest: DiscordRest, ctx: InteractionContext, message: Message): Promise<void> {
  const posted = await rest.followUp(replyTo(ctx), message)
  const ephemeral = ((message.flags ?? 0) & MessageFlags.Ephemeral) !== 0
  if (!posted.ok && ctx.channelId && !ephemeral) await rest.postToChannel(ctx.channelId, message)
}

/** Best effort: if the copy cannot be edited now, the next update of the run (the payment job, the scheduler) shows it. */
async function editMirror(rest: DiscordRest, mirror: MirrorEdit): Promise<void> {
  await rest.editChannelMessage(mirror.channelId, mirror.messageId, mirror.message)
}
