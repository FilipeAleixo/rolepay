import type { DiscordAppDeps } from './app/deps.js'
import { createDispatcher } from './app/router.js'
import { type BackgroundTiming, type InteractionTiming, createInteractionsHandler } from './http/handler.js'
import { createSignatureVerifier } from './http/verify.js'
import type { InteractionLog } from './ports.js'

/**
 * The Discord interactions endpoint, ready to mount: signature check with the
 * application's public key, then the router over the core services.
 */
export function createDiscordInteractions(opts: {
  publicKey: string
  deps: DiscordAppDeps
  waitUntil?: (work: Promise<unknown>) => void
  now?: () => Date
  /** Answers each interaction ID once (replays within the signature window get 409). */
  interactionLog?: InteractionLog
  /** One call per request as its response goes out: what was asked and how fast (content-free). */
  onResponse?: (timing: InteractionTiming) => void
  /** One call per piece of work done after the answer (a deferred reply, a late answer), as it ends: how long and where. */
  onBackground?: (timing: BackgroundTiming) => void
  /** A handler not done by then is acknowledged with a deferred response (default 1.5 s; Discord allows 3). */
  ackDeadlineMs?: number
}): (request: Request) => Promise<Response> {
  return createInteractionsHandler({
    verify: createSignatureVerifier(opts.publicKey, opts.now ? { now: opts.now } : {}),
    dispatch: createDispatcher(opts.deps, opts.ackDeadlineMs === undefined ? {} : { ackDeadlineMs: opts.ackDeadlineMs }),
    ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
    ...(opts.deps.onError ? { onError: opts.deps.onError } : {}),
    ...(opts.interactionLog ? { seen: opts.interactionLog } : {}),
    ...(opts.onResponse ? { onResponse: opts.onResponse } : {}),
    ...(opts.onBackground ? { onBackground: opts.onBackground } : {}),
  })
}
