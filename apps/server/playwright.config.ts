import { defineConfig } from '@playwright/test'

// Opt-in browser end to end on the Moderato TESTNET (chain 42431): real passkeys through
// Chromium's virtual WebAuthn authenticator, the real server on localhost (rpId localhost),
// real Tempo transactions. Run with `pnpm --filter @payrun/server test:e2e`.
export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  expect: { timeout: 90_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
})
