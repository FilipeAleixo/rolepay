import { defineConfig } from 'vitest/config'

// Server tests: config, routes, recovery loop, and the in-process end to end (memory adapters, fake Discord). No network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.chain.test.ts', '**/node_modules/**'],
    // `pnpm test:coverage` (CI): every source file counts, tested or not. The thresholds sit a little
    // below the current numbers, so a change that drops coverage fails the build.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 73, statements: 71, functions: 65, branches: 81 },
    },
  },
})
