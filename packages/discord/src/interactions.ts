import type { DiscordAppDeps } from './app/deps.js'
import { createDispatcher } from './app/router.js'
import { createInteractionsHandler } from './http/handler.js'
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
}): (request: Request) => Promise<Response> {
  return createInteractionsHandler({
    verify: createSignatureVerifier(opts.publicKey, opts.now ? { now: opts.now } : {}),
    dispatch: createDispatcher(opts.deps),
    ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
    ...(opts.deps.onError ? { onError: opts.deps.onError } : {}),
    ...(opts.interactionLog ? { seen: opts.interactionLog } : {}),
  })
}
