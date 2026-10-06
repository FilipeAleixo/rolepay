import { defineConfig } from 'vitest/config'

// Routes on the real core services (in-memory fakes) with a fake passkey session. No network.
// The browser side (passkey ceremonies, signing) is covered by the Playwright e2e in apps/server.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
