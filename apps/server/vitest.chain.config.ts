import { defineConfig } from 'vitest/config'

// Opt-in: the Discord flow through HTTP on the Moderato TESTNET (chain 42431). Run with `pnpm test:chain`.
export default defineConfig({
  test: {
    include: ['test/**/*.chain.test.ts'],
    testTimeout: 400_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
