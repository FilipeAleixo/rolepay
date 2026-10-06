import { defineConfig } from 'vitest/config'

// Opt-in: the real Anthropic API (2 to 3 calls, a few cents). Needs PAYRUN_AI_LIVE=true and
// ANTHROPIC_API_KEY (in the environment or the repo-root .env). Run with `pnpm test:ai-live`.
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 180_000,
    fileParallelism: false,
  },
})
