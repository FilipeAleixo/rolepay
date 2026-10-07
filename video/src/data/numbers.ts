/**
 * The real numbers the "By the numbers" scene counts up to. Re-read them before a final render.
 *
 * Measured on main at 8bf685e (2026-10-07) with `pnpm test` and `pnpm test:coverage` at the repo
 * root: core 699, discord 356, web 208, server 132 tests (122 files). The README's "How to verify
 * it yourself" still says 1,380 (web 197, server 128) and web 85.12%, server 85.6%: it predates the
 * last commits, so the README, not this file, is the one to update.
 */
export const TESTS = { core: 699, discord: 356, web: 208, server: 132 } as const
export const TOTAL_TESTS = TESTS.core + TESTS.discord + TESTS.web + TESTS.server

/** Line coverage per package, from `pnpm test:coverage` (what CI runs, with a threshold per package). */
export const LINE_COVERAGE = [
  { pkg: 'core', pct: 94.97 },
  { pkg: 'discord', pct: 96.59 },
  { pkg: 'web', pct: 86.23 },
  { pkg: 'server', pct: 85.92 },
] as const

/** The README's chain proofs on Moderato, each with Rolepay's own checks skipped. */
export const CHAIN_PROOFS = ['over-limit batch', 'out-of-scope call', 'revoked key'] as const

/** A warm proposal on Sonnet 5.5: "about $0.003 to $0.004" (README, measured live October 2026). */
export const AI_PROPOSAL_USD = 0.003
