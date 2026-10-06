import { defineConfig } from 'vitest/config'

// Opt-in: real Moderato testnet (chain 42431). Never mainnet. Run with `pnpm test:chain`.
export default defineConfig({
  test: {
    include: ['test/**/*.chain.test.ts'],
    testTimeout: 400_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
