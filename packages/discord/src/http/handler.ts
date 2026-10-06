import { type FileUpload, attachmentMeta, multipartBody } from '../api.js'
import type { InteractionLog } from '../ports.js'
import type { SignedRequest } from './verify.js'

/**
 * What the dispatcher (the interaction router) decided. `background` runs after the
 * response is built: deferred replies and anything slower than Discord's 3 seconds.
 */
export type Dispatched =
  | { kind: 'respond'; body: { type: number; data?: Record<string, unknown> }; files?: FileUpload[]; background?: () => Promise<void> }
  | { kind: 'invalid'; reason: string }

export type Dispatch = (interaction: unknown) => Promise<Dispatched>

export type InteractionsHandlerDeps = {
  verify: (req: SignedRequest) => Promise<boolean>
  dispatch: Dispatch
  /** Keeps background work alive past the response (Workers' ctx.waitUntil; on Node, a tracked promise). */
  waitUntil?: (work: Promise<unknown>) => void
  onError?: (error: unknown) => void
  /** Answers each interaction ID once; a replayed signed request gets 409. */
  seen?: InteractionLog
}

/**
 * The Discord interactions endpoint as a standard fetch handler (Request in, Response out),
 * so any HTTP framework can mount it. Every request is signature-checked before it is read.
 */
export function createInteractionsHandler(deps: InteractionsHandlerDeps): (request: Request) => Promise<Response> {
  const waitUntil = deps.waitUntil ?? ((p) => void p)
  const onError = deps.onError ?? (() => {})

  return async (request) => {
    const body = await request.text()
    const signed = await deps.verify({
      signature: request.headers.get('x-signature-ed25519'),
      timestamp: request.headers.get('x-signature-timestamp'),
      body,
    })
    if (!signed) return new Response('invalid request signature', { status: 401 })

    let interaction: unknown
    try {
      interaction = JSON.parse(body)
    } catch {
      return new Response('invalid JSON', { status: 400 })
    }
    const id = (interaction as { id?: unknown } | null)?.id
    if (deps.seen && typeof id === 'string' && !(await deps.seen.firstSeen(id))) {
      return new Response('interaction already handled', { status: 409 })
    }

    let result: Dispatched
    try {
      result = await deps.dispatch(interaction)
    } catch (error) {
      onError(error)
      return new Response('internal error', { status: 500 })
    }
    if (result.kind === 'invalid') return new Response('unsupported interaction', { status: 400 })

    const response = result.files?.length
      ? new Response(multipartBody(withAttachments(result.body, result.files), result.files))
      : Response.json(result.body)
    const background = result.background
    if (background) {
      waitUntil(
        // Starts on the next macrotask, after the response has been handed back.
        new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(background)
          .catch(onError),
      )
    }
    return response
  }
}

function withAttachments(body: Extract<Dispatched, { kind: 'respond' }>['body'], files: FileUpload[]) {
  return { ...body, data: { ...body.data, attachments: attachmentMeta(files) } }
}
