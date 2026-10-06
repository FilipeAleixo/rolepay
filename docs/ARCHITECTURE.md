# payrun architecture

payrun runs pay runs for the people who run a Discord community (mods, staff, bounty winners) on Tempo. An admin builds a run, a treasurer approves it with one button, and everyone is paid in one batched stablecoin transaction. Each payout line carries a memo, recipients pay no gas, and the run exports to CSV.

This document covers the whole system. `packages/core`, `packages/discord` and `apps/server` exist and are tested end to end, in process and on Moderato. The passkey claim page and the browser signing flow for the bot key are later work packages.

## Trust model

- **The community's own Tempo account (the treasury) holds the funds.** Its root key is the treasurer's passkey (or a multisig later). payrun never holds it in production.
- **The bot holds only an access key**, authorised by the root through the Account Keychain precompile with three restrictions:
  - an expiry,
  - a per-token spend limit (one-time or per period),
  - a call scope: only `transferWithMemo` on the payout token, optionally only to an allowlist of recipients.
- A leaked bot key can therefore spend at most the remaining period budget, only through `transferWithMemo`, until it expires or the root revokes it. The feasibility spike proved these limits hold inside a batch (`../tempo-payrun-spike/RESULTS.md`, summarised in the brief).
- **Fees** are paid by a sponsor (the public sponsor on testnet) or from a separate fee-budget token with its own limit. Never from the payout token under the payout limit: the fee would silently eat the payout budget.
- **Recipients register before they are paid.** `/payee link` issues a one-time link; the claim page creates a passkey account and registers its address. There are no pre-funded claim links.

## Repository layout

```
packages/core        @payrun/core: domain, ports, services, adapters
packages/discord     @payrun/discord: the Discord adapter over HTTP interactions
apps/server          @payrun/server: Hono on Node, the composition root (README: how to run it)
docs/tempo           Tempo and viem docs snapshot from the spike
docs/ARCHITECTURE.md this file
```

Dependencies point one way: `apps/server` -> `packages/discord` -> `@payrun/core` (services only). Only `apps/server` (its `src/` and `scripts/`) imports `@payrun/core/adapters`; a guard in core's architecture test fails the build otherwise.

## packages/core layers

```
caller (apps/server, packages/discord, CLI)
   |
   v
services/      CommunityService, PayeeService, PayRunService   (the ONLY public interface)
   |  uses
   v
domain/        pure: Zod schemas, types, state machine, money, memo, reconcile, CSV
ports/         interfaces: PayoutChain, *Repository, KeyVault, Clock, IdGenerator
   ^
   |  implement
adapters/      tempo/ (viem), sqlite/ (Kysely), crypto/ (node:crypto), memory/ (fakes)
```

| Layer | Can | Cannot |
| --- | --- | --- |
| `domain/` | import `zod`, `constants/`, itself | any IO: viem, kysely, `node:*`, ports, adapters |
| `ports/` | import `domain/`, `constants/` (types) | implementations |
| `services/` | import `domain/`, `ports/`, `constants/`, each other | adapters, `config/` |
| `adapters/` | import `domain/`, `ports/`, `constants/`, `config/` | services, the package root |
| `constants/` | fixed values (chain IDs, token decimals, memo layout) | anything else |
| `config/` | env parsing (operational settings) | |

These rules are enforced by `packages/core/test/architecture.test.ts`, not by memory. The same file checks that the package root exports no adapter and that nothing outside core reaches into core internals.

**Public surface.** `@payrun/core` exports `createPayrun(deps)` (returns the three services), the services' types and input schemas, domain types and schemas, port types, config and constants. `@payrun/core/adapters` exports the implementations, for composition roots only. `openPayrunAdapters(parseConfig(process.env))` opens the production set (SQLite file, AES vault, Tempo chain, random IDs, system clock).

**Results, not throws.** Every expected failure is a value: `{ ok: false, error: { code: 'snake_case', ... } }`. Services throw only for the unexpected (a database or RPC outage), which the caller treats as "try again".

**No orchestrator layer.** soulform-app puts multi-service flows in orchestrators. payrun has three services and one real flow, so services read the repositories they need directly (a pay run reads communities, keys and payees) but each entity is written only by its owning service. Add an orchestrator layer the day a flow genuinely spans services.

## Domain model

Everything is keyed by the Discord guild ID: a guild is a community.

- **Community**: guild ID, name, network, treasury address, payout token, fee mode (`sponsor` or `fee_budget`, with a fee token), approver role ID (the Treasurer role the Discord layer checks).
- **BotKey**: the bot's access key for one community. Address, sealed secret (encrypted by the KeyVault, bound to the community and key), status (`pending_authorization`, `active`, `revoked`, `superseded`), and the policy the root signed: limit, period, expiry, optional recipient allowlist (`null` = none, the v1 default), optional fee budget.
- **Payee**: (guild, Discord user) to the address of their passkey account.
- **LinkToken**: a one-time registration link. Only an HMAC fingerprint of the token is stored, so a database reader cannot hijack a link and redirect someone's pay.
- **Run**: lines (1-based, each with payee, address, amount in bigint micro-units, and its bytes32 memo), total, status, actors and timestamps, attempts, the paying tx, a failure if any, and a version for compare-and-set.

### Run state machine (`domain/run.ts`, pure)

```
draft --submit--> pending_approval --approve--> approved --start_attempt--> executing
executing --record_signed--> executing            (once per attempt)
executing --mark_paid--> paid
executing --mark_failed--> failed --start_attempt--> executing   (only if retryable)
draft | pending_approval | approved | failed --cancel--> cancelled
```

Illegal transitions return `{ ok: false, error: { code: 'illegal_transition' } }`; every (status, event) pair is tested. Failures where money may have moved (`partial_match`, `transfer_mismatch`) are never retryable: a human looks.

### Memo scheme (`constants/memo.ts`, `domain/memo.ts`)

| Bytes | Content |
| --- | --- |
| 0-1 | `"PR"` |
| 2 | version 1 |
| 3 | reserved |
| 4-27 | run ID, printable ASCII, up to 24 chars |
| 28-31 | line number, uint32 big-endian |

The memo is an indexed topic of `TransferWithMemo`, so "was line N of run R paid?" is one RPC log filter. Memos are public, so reconciliation only counts transfers from the treasury in the run's token.

## Never pay twice

`PayRunService.execute` and `reconcile` rest on three facts:

1. **One owner per attempt.** A run moves `approved -> executing` by compare-and-set on its version. A second worker (or a double click) gets `concurrent_update` and sends nothing.
2. **Persist before broadcast.** The adapter signs the batch without broadcasting; the service stores the signed tx and its hash; only then is it broadcast. Re-broadcasting the same signed tx can land it at most once.
3. **A deadline for every attempt.** Each attempt fixes `validBefore` (now + 120 s, an expiring nonce) before signing. Once chain time passes it, that tx can never land.

`reconcile` never signs anything new. In order: look up the recorded tx hash; otherwise search memo transfers from the first attempt's start block; if nothing is found and the deadline has not passed, re-broadcast the same signed tx (or report `pending`); once the deadline has passed with nothing on chain, mark the attempt `not_landed`, which makes a fresh attempt provably safe. Before any retry, `execute` checks the chain once more and refuses (`chain_shows_payments`) if any of the run's memos are there.

| Crash point | State left behind | Recovery |
| --- | --- | --- |
| after opening the attempt, before signing | `executing`, no tx | nothing was signed; after the deadline, `not_landed`, then retry |
| after signing, before recording | `executing`, no tx | nothing was broadcast; same as above |
| after recording, before broadcast | `executing`, signed tx | reconcile re-broadcasts the same tx |
| after broadcast, before recording the result | `executing`, signed tx | reconcile finds the receipt or the memos, marks `paid` |

`PayRunService.recoverInFlight()` reconciles every `executing` run; the server runs it on boot and on an interval. The crash cases are tested with fakes, on a real SQLite file, and on Moderato.

Before signing, `execute` reads the key from the chain (`checkKeyForRun`): revoked, expired, expiring inside the submission window, or a run larger than the remaining limit all fail fast with a clear code. Without this, a revoked key fails late and vaguely (the spike saw about 110 s and "Missing or invalid parameters").

## Bot key lifecycle

1. `CommunityService.provisionBotKey` mints a fresh secp256k1 key, seals the secret, stores it as `pending_authorization`, and returns the exact authorisation for the root to sign (expiry, limits, scope).
2. **Production:** the treasurer signs that authorisation with their passkey on the setup page (a later WP), and `confirmBotKey` marks the key active once the chain shows it. **Dev, CLI and tests:** `authorizeBotKey({ root })` signs with an in-process `RootSigner` (`rootSignerFromPrivateKey`), then confirms.
3. Rotation: a newly confirmed key supersedes the old active key. A revoked key ID can never be re-authorised, so rotation always mints a fresh key.
4. `revokeBotKey({ root })` (dev path) or a root revoke from anywhere; `keyStatus` always reads the chain.

A recurring limit's period is anchored at authorisation time, not at calendar months.

## Fees

- **`sponsor`**: the tx carries `feePayer: true` and is filled through a relay (`withRelay`). Testnet: the public sponsor `https://sponsor.moderato.tempo.xyz`. Mainnet: Tempo's hosted relay (API key) or a self-hosted relay; neither is configured yet, so mainnet defaults to no sponsor.
- **`fee_budget`**: the bot pays fees in a separate token (for example pathUSD) under its own small limit, authorised alongside the payout limit. The budget must cover gas limit times price up front (the keychain pre-charges, then nets back).
- "Sponsor down" is not automatic yet: a run fails as `rejected` (retryable), and switching the community to `fee_budget` is the fallback.

## Persistence

SQLite through Kysely and better-sqlite3 (`adapters/sqlite/`). The schema is portable on purpose: money as exact decimal text (Postgres `NUMERIC`), timestamps as ISO text, small nested values (key policy, attempts, failure) as JSON text. Moving to Postgres means a Kysely Postgres dialect plus the same migrations, with no service changes. Migrations live inline in `migrations.ts` and are append-only. Every row read is re-validated by the domain's Zod schema.

The repository contract (`test/support/repositoryContracts.ts`) runs against both the in-memory fakes and SQLite, so unit tests on fakes can be trusted.

## apps/server (Hono on Node)

The composition root (`src/main.ts`). It parses config (`src/config.ts`: the server's own `DISCORD_*`, `CLAIM_BASE_URL`, `HOST`/`PORT` and bot-key defaults, plus core's `PAYRUN_*` through `parseConfig`), opens the production adapters, creates the services and serves:

- `POST /discord/interactions`: the Discord interactions endpoint (HTTP interactions, no gateway bot).
- `GET /health`: `{ ok, network, jobsInFlight }`.
- `GET|POST /claim/:token`: a throwaway **testnet-only** claim page (`PAYRUN_DEV_CLAIM=true`, refused on mainnet by config) that registers a pasted or random address, so `/payee link` works end to end before the passkey claim page exists.
- The recovery sweep: `payRuns.recoverInFlight()` on start and every 30 seconds (`src/recovery.ts`), never two at once.

```ts
const config = parseServerConfig(loadEnvironment())        // root .env, DB path anchored at the repo root
const { deps, close } = await openPayrunAdapters(config.core)
const payrun = createPayrun(deps)
const server = composeServer({ config, payrun, rest: new FetchDiscordRest({ botToken }), clock: deps.clock })
```

`composeServer` (`src/compose.ts`) is the wiring shared by `main.ts` and the tests: the tests pass in-memory adapters and a fake Discord and drive the real Hono app over HTTP. Scripts: `pnpm register-commands`, and on testnet `pnpm dev:treasury` (print and fund the dev treasury) and `pnpm dev:authorize-key <guildId>` (the in-process root signs the pending bot key; in production the treasurer signs it with a passkey in a later work package). How to run it: `apps/server/README.md`.

## packages/discord

The Discord adapter. It calls core only through `@payrun/core` services; everything external is a port with an in-memory fake (`@payrun/discord/testing`).

```
http/        Ed25519 verification (WebCrypto) and the endpoint as a fetch handler: Request in, Response out
app/         Zod parsing of interactions, the router, permission rules, outcome rendering
commands/    slash command definitions (JSON) and handlers
components/  the Approve, Cancel and Retry buttons
views/       pure builders from domain objects to Discord message payloads (soulform's transformers)
execution/   the in-process ExecutionQueue and the run executor job
adapters/    DiscordRest over fetch, MemberDirectory over DiscordRest
ports.ts     DiscordRest, ExecutionQueue, MemberDirectory
```

A handler is a thin route: parse options with Zod, check permissions, call a service, return an **outcome** (`reply`, `update`, `defer` or `choices`). Handlers never talk to Discord; `app/outcome.ts` renders the outcome. A `defer` answers at once ("thinking...") and finishes in the background, then edits the reply through the interaction webhook; a public deferral that fails is deleted and the error goes to the caller alone. Layering is enforced by `packages/discord/test/architecture.test.ts`: discord imports only `@payrun/core` and `zod`; views import nothing with IO; handlers never reach adapters, the HTTP layer or the queue implementation.

| Command / component | Who | Service calls |
| --- | --- | --- |
| `/payrun setup` | Manage Server | `communities.register` (first time, needs `treasury`), `setApproverRole`, `keyStatus`, `provisionBotKey` when there is no usable key (none, revoked, expired, or `new_key`) |
| `/payee link` | anyone | `payees.issueLink`, replied ephemerally with `${CLAIM_BASE_URL}/${token}` |
| `/payrun new` | Manage Server or approver | `payees.list` + member lookup for `role`, `payRuns.create`, `payRuns.submit`; the review embed is posted publicly |
| Approve | approver role only | `payRuns.approve({ actorCanApprove: true })`, then enqueue execution |
| Cancel | creator, Manage Server or approver | `payRuns.cancel` |
| Retry | approver role only | enqueue execution for an approved-but-unpaid or retryable failed run |
| `/payrun status` | Manage Server or approver | `payRuns.get`, or `payRuns.list` + `communities.keyStatus` (deferred: reads the chain) |
| `/payrun export` | Manage Server or approver | `payRuns.exportCsv` (default: the latest run), sent as a CSV attachment |

Decisions worth knowing:

- **Recipients.** `/payrun new amount:<per person>` takes `role:` (every registered payee holding it), `users:` (mentions or IDs, `@bob=40` overrides the amount for one person), or both. Only registered payees can hold a line, so role filtering checks each registered payee with Get Guild Member, which needs **no privileged intent**. A List Guild Members implementation (which needs the GUILD_MEMBERS intent) can replace it behind the `MemberDirectory` port if a server ever has more payees than that is comfortable for.
- **Submit at create.** `/payrun new` creates and submits in one go, so a run shown for review is `pending_approval`. Approve is one transition.
- **Approve answers with UPDATE_MESSAGE.** The review turns into "Approved, paying..." with no buttons inside the 3-second window (so nobody can click twice), the job is queued, and the job edits that same message with the result. A deferred update would leave the buttons live until the job finishes.
- **Permissions** are checked from the signed interaction (`member.roles`, `member.permissions`), never trusted from `default_member_permissions` alone, which only hides `/payrun` from non-admins by default (admins can grant it to the Treasurer role in Server Settings > Integrations). Manage Server alone cannot approve.

### Execution

Discord requires an answer within 3 seconds; paying can take longer. Approve and Retry enqueue an `ExecutionJob` on the **`ExecutionQueue` port**:

```ts
type ExecutionJob = { kind: 'execute_run'; guildId: string; runId: string; reply: { applicationId: string; token: string }; channelId: string | null }
interface ExecutionQueue { enqueue(job: ExecutionJob): Promise<void> }
```

`InProcessExecutionQueue` runs jobs in the background, one at a time per run, different runs in parallel. The job (`createRunExecutor`) calls `payRuns.execute`; while the outcome is `pending` it waits until `retryAfter` (plus a second of slack) and calls `reconcile`, up to 12 checks, then hands over to the recovery sweep; on `concurrent_update` it follows the other worker with `reconcile` and never re-sends. It edits the message through the interaction webhook (tokens last 15 minutes; after that it posts to the channel as the bot), and once paid it DMs each payee a receipt through `DiscordRest`. A pre-flight failure (no active key, over the limit, revoked) leaves the run `approved` and shows the reason with a Retry button. Because `execute` is idempotent and the boot sweep recovers anything in flight, losing the in-process queue in a crash loses no money and pays nothing twice. A durable queue can replace it behind the same port.

## Testing

| Suite | Where | Runs |
| --- | --- | --- |
| Unit (domain, services on fakes) | `packages/core/src/**/*.test.ts` | `pnpm test` |
| Repository contract (memory + SQLite) | `packages/core/test/support/repositoryContracts.ts` | `pnpm test` |
| SQLite integration (temp file DB) | `packages/core/**/*.integration.test.ts` | `pnpm test` |
| Architecture guards | `packages/core/test/architecture.test.ts`, `packages/discord/test/architecture.test.ts` | `pnpm test` |
| Discord: verification, routing, every handler, views, executor, queue, REST adapter | `packages/discord/src/**/*.test.ts` (real core on in-memory fakes, fake Discord REST) | `pnpm test` |
| Server: config, routes, dev claim page, recovery loop, in-process end to end over signed HTTP | `apps/server/**/*.test.ts` | `pnpm test` |
| Chain, Moderato testnet, opt-in | `packages/core/test/payrun.chain.test.ts`, `apps/server/test/server.chain.test.ts` | `pnpm test:chain` |

The core chain test generates throwaway keys into the gitignored `.env`, funds the treasury from the faucet, and runs a full service-level pay run: register, key authorised with a limit, three payees via links, a 3-line sponsored batch, reconcile from memo events, idempotent re-execute, crash recovery from a restarted process, an over-limit run refused before signing, revoke, CSV export. The server chain test reuses those keys and drives the whole Discord flow through the signed HTTP endpoint with production adapters and a fake Discord REST: setup, links claimed on the dev page, `/payrun new`, Approve, one sponsored batch, receipts. Both refuse any chain but Moderato.

The in-process end to end (`apps/server/test/e2e.test.ts`) does the same over HTTP with in-memory adapters, and also covers a crash between approval and execution (status offers Retry; still one payment).

## Known limits and open decisions

- At most 50 lines per run (Tempo's 30M gas cap per tx at about 300k gas per first transfer to a fresh address, with a 2x margin). Raise only after a chain test at the new size.
- One active bot key per community. Payees are per community (the same person in two guilds registers twice).
- The run creator may also approve it (if they hold the approver role). A four-eyes rule would be a community setting.
- No recipient allowlist by default; adding a payee to an allowlist needs a root-signed `setAllowedCalls` (a passkey prompt), which is why it is off in v1.
- Mainnet: guarded by `PAYRUN_ALLOW_MAINNET=true`; no sponsor configured, so communities there use `fee_budget`. `/payrun setup` registers sponsored communities only; a `fee_token` option is WP7 work.
- One amount per person in `/payrun new` (with per-user overrides). A CSV or modal for many different amounts is later.
- A run the recovery sweep finishes after a restart does not update its Discord message or send receipts; `/payrun status` shows the truth. Receipts are best effort and not recorded, so they are never re-sent.
- The community's name is not stored from Discord yet (interactions carry no guild name); the claim page and receipts show the guild ID or "your Discord server".
- The treasury and payout token cannot be changed after registration (no service method for it yet).
