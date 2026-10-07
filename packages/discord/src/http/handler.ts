import { type FileUpload, attachmentMeta, multipartBody } from '../api.js'
import type { InteractionLog } from '../ports.js'
import type { SignedRequest } from './verify.js'

/** What was asked, for the log: the interaction kind and the command, button or form name. Never options or text. */
export type InteractionLabel = { kind: string; name: string }

/** What background work says about itself for the log: milliseconds per phase (Discord REST, database...). */
export type BackgroundReport = { phases?: Record<string, number> }

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
  background?: () => Promise<void | BackgroundReport>
  label?: InteractionLabel
  late?: boolean
  failed?: boolean
}
export type Dispatched = Responded | { kind: 'invalid'; reason: string }

/**
 * One log line per request, content-free: what was asked, how long until the response was handed
 * to the HTTP server (Discord allows 3 seconds), its type (null when refused) and whether it went well.
 * `sinceCreatedMs`: from Discord creating the interaction (the time inside its ID) to the request
 * reaching us, so a slow answer can be placed on Discord's side or ours (null without an ID).
 */
export type InteractionTiming = InteractionLabel & {
  ms: number
  sinceCreatedMs: number | null
  status: number
  responseType: number | null
  ok: boolean
  late: boolean
}

/** One log line per piece of background work, as it ends: how long it took after the answer and where. */
export type BackgroundTiming = InteractionLabel & { ms: number; ok: boolean; phases: Record<string, number> }

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
  /** Called once per background job (a deferred reply, a late answer), as it ends. */
  onBackground?: (timing: BackgroundTiming) => void
  /** Milliseconds, for the timings. Default: performance.now(). */
  now?: () => number
  /** Wall-clock milliseconds, to compare with the time in an interaction's ID. Default: Date.now(). */
  wallClock?: () => number
}

/** Discord's epoch: a snowflake ID carries its creation time as milliseconds since 2015-01-01, shifted left 22 bits. */
const DISCORD_EPOCH_MS = 1_420_070_400_000

/** When Discord created the thing with this ID, in wall-clock milliseconds; null for anything that is not a snowflake. */
function snowflakeTime(id: unknown): number | null {
  if (typeof id !== 'string' || !/^\d{15,20}$/.test(id)) return null
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS
}

/**
 * The Discord interactions endpoint as a standard fetch handler (Request in, Response out),
 * so any HTTP framework can mount it. Every request is signature-checked before it is read.
 */
export function createInteractionsHandler(deps: InteractionsHandlerDeps): (request: Request) => Promise<Response> {
  const waitUntil = deps.waitUntil ?? ((p) => void p)
  const onError = deps.onError ?? (() => {})
  const now = deps.now ?? (() => performance.now())
  const wallClock = deps.wallClock ?? (() => Date.now())

  return async (request) => {
    const started = now()
    const arrived = wallClock()
    let sinceCreatedMs: number | null = null
    const refuse = (status: number, text: string, kind: string) => {
      deps.onResponse?.({ kind, name: '', ms: Math.round(now() - started), sinceCreatedMs, status, responseType: null, ok: false, late: false })
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
    const created = snowflakeTime(id)
    sinceCreatedMs = created === null ? null : Math.round(arrived - created)
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
    const label = result.label ?? { kind: 'unknown', name: '' }
    const background = result.background
    if (background) {
      const timed = async () => {
        const began = now()
        let ok = false
        let phases: Record<string, number> = {}
        try {
          const report = (await background()) as BackgroundReport | undefined
          phases = report?.phases ?? {}
          ok = true
        } finally {
          deps.onBackground?.({ ...label, ms: Math.round(now() - began), ok, phases })
        }
      }
      waitUntil(
        // Starts on the next macrotask, after the response has been handed back.
        new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(timed)
          .catch(onError),
      )
    }
    deps.onResponse?.({ ...label, ms: Math.round(now() - started), sinceCreatedMs, status: 200, responseType: result.body.type, ok: !result.failed, late: result.late ?? false })
    return response
  }
}

function withAttachments(body: Responded['body'], files: FileUpload[]) {
  return { ...body, data: { ...body.data, attachments: attachmentMeta(files) } }
}
