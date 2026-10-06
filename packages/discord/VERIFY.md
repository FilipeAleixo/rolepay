# Verify @payrun/discord by hand

About 3 minutes. From the repo root.

1. `pnpm --filter @payrun/discord test`. Expect every test green and no network calls: signature checks, routing, each command and button on the real core services (in-memory fakes), the views, the executor job, the queue, the REST adapter against a scripted fetch, and the layering guards.
2. Read `apps/server/test/e2e.test.ts`: the whole flow through the signed HTTP endpoint, from `/payrun setup` to the CSV export. `pnpm --filter @payrun/server test` runs it.
3. The real thing on Discord: `apps/server/README.md` (setup, then the 10-minute manual test).
