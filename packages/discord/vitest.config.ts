import { defineConfig } from 'vitest/config'

// Unit tests: handlers on the real core services (in-memory fakes) and a fake Discord REST. No network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
