/**
 * @rolepay/discord: the Discord adapter over HTTP interactions (no gateway bot). Calls
 * core only through `@rolepay/core` services. Fakes for tests: `@rolepay/discord/testing`.
 */
export { type FileUpload, type Message } from './api.js'
export type { DiscordAppConfig, DiscordAppDeps } from './app/deps.js'
export { createDispatcher } from './app/router.js'
export { type TextChannel, type TreasuryEvent, confirmTreasuryChannel, readTextChannels } from './app/treasury.js'
export { COMMAND_DEFINITIONS, commandDefinitions } from './commands/definitions.js'
export { FetchDiscordRest, type FetchDiscordRestOptions } from './adapters/fetchDiscordRest.js'
export { KvInteractionLog } from './adapters/kvInteractionLog.js'
export { KvPendingSources } from './adapters/kvPendingSources.js'
export { KvRunNotices } from './adapters/kvRunNotices.js'
export { RestActivityReader } from './adapters/restActivityReader.js'
export { RestMemberDirectory } from './adapters/restMemberDirectory.js'
export { InProcessExecutionQueue } from './execution/inProcessQueue.js'
export { type PolicyNotifierDeps, createPolicyNotifier } from './execution/policyNotifier.js'
export { type RecoveryNotifierDeps, createRecoveryNotifier } from './execution/recoveryNotifier.js'
export { type JobReport, type RunExecutorDeps, createRunExecutor } from './execution/runExecutor.js'
export { type BackgroundTiming, type Dispatch, type Dispatched, type InteractionTiming, createInteractionsHandler } from './http/handler.js'
export { type SignedRequest, createSignatureVerifier } from './http/verify.js'
export { createDiscordInteractions } from './interactions.js'
export type * from './ports.js'
