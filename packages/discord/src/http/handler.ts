import { type FileUpload, attachmentMeta, multipartBody } from '../api.js'
import type { InteractionLog } from '../ports.js'
import type { SignedRequest } from './verify.js'

/** What was asked, for the log: the interaction kind and the command, button or form name. Never options or text. */
export type InteractionLabel = { kind: string; name: string }

/**
 * What the dispatcher (the interaction router) decided. `background` runs after the
 * response is built: deferred replies and anything slower than Discord's 3 seconds.
 * `late`: the handler missed the deadline and this is the deferred acknowledgement;
 * `failed`: the handler threw and this is the apology.
 */
export type Responded = {
  kind: 'respond'
  body: { type: number; data?: Record<string, unknown> }
  files?: FileUpload[]
  background?: () => Promise<void>
  label?: InteractionLabel
  late?: boolean
  failed?: boolean
}
export type Dispatched = Responded | { kind: 'invalid'; reason: string }

/**
 * One log line per request, content-free: what was asked, how long until the response was handed
 * to the HTTP server (Discord allows 3 seconds), its type (null when refused) and whether it went well.
 */
export type InteractionTiming = InteractionLabel & { ms: number; status: number; responseType: number | null; ok: boolean; late: boolean }

export type Dispatch = (interaction: unknown) => Promise<Dispatched>

export type InteractionsHandlerDeps = {
  verify: (req: SignedRequest) => Promise<boolean>
  dispatch: Dispatch
  /** Keeps background work alive past the response (Workers' ctx.waitUntil; on Node, a tracked promise). */
  waitUntil?: (work: Promise<unknown>) => void
  onError?: (error: unknown) => void
  /** Answers each interaction ID once; a replayed signed request gets 409. */
  seen?: InteractionLog
  /** Called once per request, as the response goes out. */
  onResponse?: (timing: InteractionTiming) => void
  /** Milliseconds, for the timings. Default: performance.now(). */
  now?: () => number
}

/**
 * The Discord interactions endpoint as a standard fetch handler (Request in, Response out),
 * so any HTTP framework can mount it. Every request is signature-checked before it is read.
 */
export function createInteractionsHandler(deps: InteractionsHandlerDeps): (request: Request) => Promise<Response> {
  const waitUntil = deps.waitUntil ?? ((p) => void p)
  const onError = deps.onError ?? (() => {})
  const now = deps.now ?? (() => performance.now())

  return async (request) => {
    const started = now()
    const refuse = (status: number, text: string, kind: string) => {
      deps.onResponse?.({ kind, name: '', ms: Math.round(now() - started), status, responseType: null, ok: false, late: false })
      return new Response(text, { status })
    }
    const body = await request.text()
    const signed = await deps.verify({
      signature: request.headers.get('x-signature-ed25519'),
      timestamp: request.headers.get('x-signature-timestamp'),
      body,
    })
    if (!signed) return refuse(401, 'invalid request signature', 'unverified')

    let interaction: unknown
    try {
      interaction = JSON.parse(body)
    } catch {
      return refuse(400, 'invalid JSON', 'invalid')
    }
    const id = (interaction as { id?: unknown } | null)?.id
    if (deps.seen && typeof id === 'string' && !(await deps.seen.firstSeen(id))) {
      return refuse(409, 'interaction already handled', 'replay')
    }

    let result: Dispatched
    try {
      result = await deps.dispatch(interaction)
    } catch (error) {
      onError(error)
      return refuse(500, 'internal error', 'error')
    }
    if (result.kind === 'invalid') return refuse(400, 'unsupported interaction', 'invalid')

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
    const label = result.label ?? { kind: 'unknown', name: '' }
    deps.onResponse?.({ ...label, ms: Math.round(now() - started), status: 200, responseType: result.body.type, ok: !result.failed, late: result.late ?? false })
    return response
  }
}

function withAttachments(body: Responded['body'], files: FileUpload[]) {
  return { ...body, data: { ...body.data, attachments: attachmentMeta(files) } }
}
