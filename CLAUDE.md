# CLAUDE.md

payrun: Discord-native pay runs on Tempo. A community's own Tempo account holds the funds; the bot holds only a limited access key. Read `docs/ARCHITECTURE.md` before changing anything; `docs/tempo/` has the Tempo and viem docs snapshot.

## Commands

```bash
pnpm typecheck     # strict TS, all packages
pnpm test          # unit + SQLite integration + architecture guards (no network)
pnpm test:chain    # opt-in: full pay run on the Moderato TESTNET (chain 42431)
```

## Rules

1. **Layers (enforced by `packages/core/test/architecture.test.ts`).** `domain/` is pure (zod and constants only, no IO). `ports/` are interfaces. `services/` import only domain, ports and constants, and are the only public interface. `adapters/` implement ports and never import services. Callers use `@payrun/core` and, in composition roots only, `@payrun/core/adapters`. Never import core internals from another package.
2. **TDD.** Write the failing test, watch it fail for the right reason, write the minimum to pass, refactor. For a test that passes on first run (an integration test of existing behaviour), mutate the code once to prove it can fail.
3. **Money is bigint micro-units (6 decimals).** Parse with `parseAmount`, print with `formatAmount`. No floats, no `parseFloat`, no `toFixed`. Store as decimal text.
4. **Expected failures are results**, `{ ok: false, error: { code } }` with snake_case codes. Throw only for the unexpected.
5. **Zod schemas in `domain/` are the source of truth** for shapes; repositories re-validate every row they read.
6. **Never pay twice.** Do not weaken the compare-and-set on run versions, persisting the signed tx before broadcast, the validBefore deadline, or the memo check before a retry. See "Never pay twice" in the architecture doc.
7. **Find a sibling first.** New service, adapter or repository: copy the shape of an existing one. New repository behaviour goes into the shared contract (`test/support/repositoryContracts.ts`) so fakes and SQLite stay equal.
8. **Config vs constants.** `config/` = operational settings from env. `constants/` = fixed facts (chain IDs, token decimals, memo layout).
9. **Migrations are append-only** once shipped (`adapters/sqlite/migrations.ts`). Keep the schema portable to Postgres.

## Secrets and networks

- **No secrets in git.** Keys live in `.env` (gitignored); `.env.example` lists the names. Never print key values, in logs, tests or commit messages.
- **Tests are testnet-only by default.** `pnpm test` makes no network calls. `pnpm test:chain` refuses any chain but Moderato. Mainnet needs `PAYRUN_NETWORK=mainnet` plus `PAYRUN_ALLOW_MAINNET=true`, and never runs in tests.
- Allowed network calls: Tempo testnet RPC, sponsor and faucet; npm installs.

## Tempo gotchas (from the spike, encoded in `adapters/tempo/`)

- `viem` 2.57.3 has Tempo built in (`viem/tempo`). Keychain address in lowercase.
- Always set `validBefore` explicitly (now + 120 s); viem's 25 s default goes stale on retries.
- The public RPC sometimes returns a receipt about 60 s late, an HTML error page, or `-32002 no healthy upstreams`: `idempotentSend` recovers receipts by hash and `retryUnavailable` retries -32002. Never re-sign on an ambiguous error.
- Revoked or expired keys fail late as "Missing or invalid parameters": check key state before every run (`checkKeyForRun`).
- Fees from the payout token come off the payout limit: use the sponsor or a separate fee budget.

## Writing

Plain English in docs and code comments. No em dashes.
