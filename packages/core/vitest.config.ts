import { defineConfig } from 'vitest/config'

// Default suite: unit tests (in-memory fakes) + SQLite integration tests. No network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.chain.test.ts', '**/node_modules/**'],
  },
})
