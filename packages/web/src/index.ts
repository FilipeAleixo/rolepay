/**
 * @payrun/web: the web pages over HTTP (the recipient claim page and the treasurer setup
 * page), their JSON endpoints, the WebAuthn ceremonies and the client bundle. Calls core
 * only through `@payrun/core` services. Fakes for tests: `@payrun/web/testing`.
 */
export { type WebAppDeps, createWebApp } from './app.js'
export { bundledAssets } from './assets.js'
export type { WebConfig } from './config.js'
export { accountsKv, createPasskeys, passkeyAddress, withLoginProof } from './passkeys.js'
export { TokenBucketLimiter } from './rateLimit.js'
export type * from './ports.js'
