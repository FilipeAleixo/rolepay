# CLAUDE.md

Rolepay: Discord-native pay runs on Tempo. A community's own Tempo account holds the funds; the bot holds only a limited access key. Read `docs/ARCHITECTURE.md` before changing anything; `docs/tempo/` has the Tempo and viem docs snapshot.

## Commands

```bash
pnpm typecheck     # strict TS, all packages
pnpm test          # unit + SQLite integration + architecture guards + discord + web + server e2e (no network)
pnpm test:coverage # the same with v8 coverage and per-package thresholds (what CI runs, .github/workflows/ci.yml)
pnpm test:chain    # opt-in: full pay runs on the Moderato TESTNET (chain 42431), service level and over HTTP
pnpm test:e2e      # opt-in: Playwright, real passkeys (virtual authenticator) on localhost, Moderato
pnpm test:ai-live  # opt-in: three real Anthropic API calls (ROLEPAY_AI_LIVE=true and ANTHROPIC_API_KEY)
pnpm dev           # the server (apps/server/README.md: Discord setup and the manual test)
pnpm register-commands                 # PUT the slash commands to Discord (needs DISCORD_APP_ID, DISCORD_BOT_TOKEN)
pnpm dev:treasury / dev:authorize-key  # testnet dev shortcut (ROLEPAY_DEV_SHORTCUTS=true): fund a dev treasury, authorise its pending bot key (production: the setup page)
```

## Rules

1. **Layers (enforced by `packages/core/test/architecture.test.ts`).** `domain/` is pure (zod and constants only, no IO). `ports/` are interfaces. `services/` import only domain, ports and constants, and are the only public interface. `adapters/` implement ports and never import services. Callers use `@rolepay/core` and, in composition roots only, `@rolepay/core/adapters`. Never import core internals from another package.
2. **TDD.** Write the failing test, watch it fail for the right reason, write the minimum to pass, refactor. For a test that passes on first run (an integration test of existing behaviour), mutate the code once to prove it can fail.
3. **Money is bigint micro-units (6 decimals).** Parse with `parseAmount`, print with `formatAmount` (anything read back: CSV, memos, JSON, form fields) or `displayAmount` (for people: embeds and pages, thousands grouped as "999,995"). No floats, no `parseFloat`, no `toFixed`. Store as decimal text.
4. **Expected failures are results**, `{ ok: false, error: { code } }` with snake_case codes. Throw only for the unexpected.
5. **Zod schemas in `domain/` are the source of truth** for shapes; repositories re-validate every row they read.
6. **Never pay twice.** Do not weaken the compare-and-set on run versions, persisting the signed tx before broadcast, the validBefore deadline, or the memo check before a retry. See "Never pay twice" in the architecture doc.
7. **Find a sibling first.** New service, adapter or repository: copy the shape of an existing one. New repository behaviour goes into the shared contract (`test/support/repositoryContracts.ts`) so fakes and SQLite stay equal.
8. **Config vs constants.** `config/` = operational settings from env. `constants/` = fixed facts (chain IDs, token decimals, memo layout).
9. **Migrations are append-only** once shipped (`adapters/sqlite/migrations.ts`). Keep the schema portable to Postgres.
10. **Discord layer (enforced by `packages/discord/test/architecture.test.ts`).** `packages/discord` imports only `@rolepay/core` and `zod`. A handler parses options with Zod, checks permissions from the signed interaction, calls a service and returns an outcome; it never calls Discord itself. Views are pure builders. Everything external (Discord REST, the execution queue, member lookup) is a port with a fake in `@rolepay/discord/testing`. Only `apps/server` imports `@rolepay/core/adapters`.
11. **Web layer (enforced by `packages/web/test/architecture.test.ts`).** `packages/web` server code imports only `@rolepay/core`, hono, zod, `accounts/server`, `viem/tempo`, esbuild and node; `src/client/` (the browser bundle) imports only `accounts` and `viem`. An address is always derived from the verified passkey session, never taken from the page. POSTs must be same-origin.
12. **Renamed from payrun.** Leave alone what keeps data and messages from before the rename working: the memo layout and its `"PR"` bytes, the vault's HKDF labels, `payrun.db`, the `PAYRUN_*` fallback, `payrun:` button IDs and the passkey-login key. The list is "Renamed from payrun" in the architecture doc.

## Secrets and networks

- **No secrets in git.** Keys live in `.env` (gitignored); `.env.example` lists the names. Never print key values, in logs, tests or commit messages.
- **Tests are testnet-only by default.** `pnpm test` makes no network calls. `pnpm test:chain` refuses any chain but Moderato. Mainnet needs `ROLEPAY_NETWORK=mainnet` plus `ROLEPAY_ALLOW_MAINNET=true`, `ROLEPAY_PAYOUT_TOKEN` and (no sponsor there) `ROLEPAY_FEE_TOKEN`, and never runs in tests; the mainnet server is `fly.app.toml` (runbook `apps/server/MAINNET.md`, checked by `apps/server/test/flyConfig.test.ts`). `ROLEPAY_SPONSOR_URL=none` rehearses mainnet's unsponsored path on Moderato (`apps/server/e2e/mainnetPath.spec.ts`). The dev shortcuts (`/rolepay setup treasury:`, `new_key`, `key_limit`, the dev scripts) need `ROLEPAY_DEV_SHORTCUTS=true`, which config refuses off Moderato. The demo controls (`/rolepay policy run_now`, one-minute veto windows) need `ROLEPAY_DEMO_CONTROLS=true`, also Moderato only, and are separate on purpose: the public demo has them without the dev shortcuts.
- Allowed network calls: Tempo testnet RPC, sponsor and faucet; npm installs; Anthropic's API only from `pnpm test:ai-live` (opt-in) and the running server.
- **AI proposals never pay.** The model only proposes; code checks every line (`domain/proposal/`), the run goes through `PayRunService.create` and the normal approval, and the bot key's limit caps it on chain. Message text is untrusted data; never log it (counts and cost only). Sonnet 5.5 (the default, prompt-cached) and Opus 5.5: no `temperature`, thinking cannot be disabled (low effort instead), no forced `tool_choice`.

## Tempo gotchas (from the spike, encoded in `adapters/tempo/`)

- `viem` 2.57.3 has Tempo built in (`viem/tempo`). Keychain address in lowercase.
- Always set `validBefore` explicitly (now + 120 s); viem's 25 s default goes stale on retries.
- The public RPC sometimes returns a receipt about 60 s late, an HTML error page, or `-32002 no healthy upstreams`: `idempotentSend` recovers receipts by hash and `retryUnavailable` retries -32002. Never re-sign on an ambiguous error.
- Revoked or expired keys fail late as "Missing or invalid parameters": check key state before every run (`checkKeyForRun`).
- Fees from the payout token come off the payout limit: use the sponsor or a separate fee budget.
- Passkeys (WebAuthn) bind to the rpId for good, need https or `http://localhost` (never an IP), and a returning sign-in does not return the public key: the server keeps it (`Handler.webAuthn` over the KeyValueStore). A WebAuthn P256 root can authorise and revoke access keys exactly like a secp256k1 one (proven on Moderato).

## Writing

Plain English in docs and code comments. No em dashes.
