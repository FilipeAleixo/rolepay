import { defineConfig } from 'vitest/config'

// Unit tests: handlers on the real core services (in-memory fakes) and a fake Discord REST. No network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // `pnpm test:coverage` (CI): every source file counts, tested or not. The thresholds sit a little
    // below the current numbers, so a change that drops coverage fails the build.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 93, statements: 91, functions: 93, branches: 79 },
    },
  },
})
