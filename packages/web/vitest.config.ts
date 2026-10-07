import { defineConfig } from 'vitest/config'

// Routes on the real core services (in-memory fakes) with a fake passkey session. No network.
// The browser side (passkey ceremonies, signing) is covered by the Playwright e2e in apps/server.
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
      thresholds: { lines: 79, statements: 76, functions: 75, branches: 71 },
    },
  },
})
