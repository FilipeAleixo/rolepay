/**
 * The real numbers the "By the numbers" scene counts up to. Re-read them before a final render.
 *
 * Measured on main at 28fa797 (2026-10-09) with `pnpm test` at the repo root, and the same as the
 * README's "How to verify it yourself": 1,998 tests in 163 files (core 965, discord 463, web 400,
 * server 170). Line coverage is the README's table, from `pnpm test:coverage`.
 */
export const TESTS = { core: 965, discord: 463, web: 400, server: 170 } as const
export const TOTAL_TESTS = TESTS.core + TESTS.discord + TESTS.web + TESTS.server

/** Line coverage per package, from `pnpm test:coverage` (what CI runs, with a threshold per package). */
export const LINE_COVERAGE = [
  { pkg: 'core', pct: 95.94 },
  { pkg: 'discord', pct: 96.97 },
  { pkg: 'web', pct: 88.84 },
  { pkg: 'server', pct: 86.83 },
] as const

/** `pnpm test:chain` on Moderato (run 2026-10-09): 39 tests in 10 files (9 in packages/core/test, 1 in apps/server/test). */
export const CHAIN_SUITE = { tests: 39, files: 10 } as const

/**
 * The distinct on-chain proofs the README links on Moderato's explorer, in its order: the bot key's
 * limit, scope and revocation (protocolLimit, protocolKey), a policy's own key (policyKey),
 * preferred stablecoins through the DEX (preferredToken) and deposit addresses (funding).
 */
export const CHAIN_PROOFS = [
  'over-limit batch',
  'out-of-scope call',
  'revoked key',
  'a policy paid with its own key',
  'a policy key over its own limit',
  'a revoked policy key',
  'two stablecoins in one batch',
  'a swap over its cap',
  'the swap scope outside a run',
  'attributed deposits, no sweep',
] as const

/** A warm proposal on Sonnet 5.5: "about $0.003 to $0.004" (README, measured live October 2026). */
export const AI_PROPOSAL_USD = 0.003
