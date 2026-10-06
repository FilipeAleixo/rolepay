import { defineConfig } from 'vitest/config'

// Default suite: unit tests (in-memory fakes) + SQLite integration tests. No network: chain
// and live AI tests have their own configs.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.chain.test.ts', '**/*.live.test.ts', '**/node_modules/**'],
  },
})
