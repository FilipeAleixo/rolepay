import { defineConfig } from 'vitest/config'

// Default suite: unit tests (in-memory fakes) + SQLite integration tests. No network: chain
// and live AI tests have their own configs.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.chain.test.ts', '**/*.live.test.ts', '**/node_modules/**'],
    // `pnpm test:coverage` (CI): every source file counts, tested or not. The thresholds sit a little
    // below the current numbers, so a change that drops coverage fails the build.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 91, statements: 88, functions: 90, branches: 80 },
    },
  },
})
