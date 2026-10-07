/**
 * @rolepay/web: the web pages over HTTP (the recipient claim page, the treasurer setup page and
 * the dashboard), their JSON endpoints, the WebAuthn ceremonies and the client bundle. Calls core
 * only through `@rolepay/core` services. Fakes for tests: `@rolepay/web/testing`.
 */
export { type WebAppDeps, createWebApp } from './app.js'
export { bundledAssets } from './assets.js'
export type { WebConfig } from './config.js'
export type { DashboardDeps } from './dashboard/index.js'
export { FetchDiscordOAuth } from './dashboard/discordOAuth.js'
export type * from './dashboard/ports.js'
export type * from './dashboard/policyPort.js'
export { accountsKv, createPasskeys, passkeyAddress, withLoginProof } from './passkeys.js'
export { TokenBucketLimiter } from './rateLimit.js'
export type * from './ports.js'
