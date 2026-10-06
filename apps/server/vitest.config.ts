import { defineConfig } from 'vitest/config'

// Server tests: config, routes, recovery loop, and the in-process end to end (memory adapters, fake Discord). No network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.chain.test.ts', '**/node_modules/**'],
  },
})
