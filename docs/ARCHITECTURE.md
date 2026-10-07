# Rolepay architecture

Rolepay runs pay runs for the people who run a Discord community (mods, staff, bounty winners) on Tempo. An admin builds a run, a treasurer approves it with one button, and everyone is paid in one batched stablecoin transaction. Each payout line carries a memo, recipients pay no gas, and the run exports to CSV.

This document covers the whole system. `packages/core`, `packages/discord`, `packages/web` and `apps/server` exist and are tested end to end: in process, on Moderato, and in a real browser with a virtual passkey authenticator (recipients claim with a passkey; the treasurer's passkey creates the treasury and signs the bot key's authorisation and its revocation).

## Trust model

- **The community's own Tempo account (the treasury) holds the funds.** Its root key is the treasurer's passkey (or a multisig later), created on the setup page. Rolepay never holds it in production: the browser signs with it, the server only reads the result from the chain.
- **The bot holds only an access key**, authorised by the root through the Account Keychain precompile with three restrictions:
  - an expiry,
  - a per-token spend limit (one-time or per period),
  - a call scope: only `transferWithMemo` on the payout token, optionally only to an allowlist of recipients.
- A leaked bot key can therefore spend at most its budget per period, only through `transferWithMemo`, until it expires or the root revokes it (a key valid for several periods can spend once per period). Replacing the key revokes the old one on chain in the same transaction, so there is one live key, and the server destroys the old key's sealed secret. The feasibility spike proved these limits hold inside a batch (`../tempo-payrun-spike/RESULTS.md`, summarised in the brief).
- **Fees** are paid by a sponsor (the public sponsor on testnet) or from a separate fee-budget token with its own limit. Never from the payout token under the payout limit: the fee would silently eat the payout budget.
- **Recipients register before they are paid.** `/payee link` issues a one-time link; the claim page creates a passkey account and registers its address (taken from the passkey session the server verified, never from the page). There are no pre-funded claim links.

## Repository layout

```
packages/core        @rolepay/core: domain, ports, services, adapters
packages/discord     @rolepay/discord: the Discord adapter over HTTP interactions
packages/web         @rolepay/web: the claim and treasurer setup pages, WebAuthn ceremonies, the client bundle
apps/server          @rolepay/server: Hono on Node, the composition root (README: how to run it)
docs/tempo           Tempo and viem docs snapshot from the spike
docs/ARCHITECTURE.md this file
```

Dependencies point one way: `apps/server` -> `packages/discord` and `packages/web` -> `@rolepay/core` (services only). Discord and web never import each other. Only `apps/server` (its `src/` and `scripts/`) imports `@rolepay/core/adapters`; a guard in core's architecture test fails the build otherwise.

## packages/core layers

```
caller (apps/server, packages/discord, CLI)
   |
   v
services/      CommunityService, PayeeService, PayRunService, ProposalService   (the ONLY public interface)
   |  uses
   v
domain/        pure: Zod schemas, types, state machine, money, memo, reconcile, CSV, proposal/
ports/         interfaces: PayoutChain, *Repository, KeyValueStore, KeyVault, Clock, IdGenerator,
               RunProposer, ActivityReader, ProposalLog
   ^
   |  implement
adapters/      tempo/ (viem), sqlite/ (Kysely), crypto/ (node:crypto), anthropic/ (the SDK),
               kv/ (proposals on the KeyValueStore), memory/ (fakes)
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

**Public surface.** `@rolepay/core` exports `createRolepay(deps)` (returns the four services), the services' types and input schemas, domain types and schemas, port types, config and constants. `@rolepay/core/adapters` exports the implementations, for composition roots only. `openRolepayAdapters(parseConfig(process.env))` opens the production set (SQLite file, AES vault, Tempo chain, random IDs, system clock) and returns `{ deps, kv, close }`: `kv` is the KeyValueStore in the same database file.

**Results, not throws.** Every expected failure is a value: `{ ok: false, error: { code: 'snake_case', ... } }`. Services throw only for the unexpected (a database or RPC outage), which the caller treats as "try again".

**No orchestrator layer.** soulform-app puts multi-service flows in orchestrators. Rolepay has four services and two real flows, so services read the repositories they need directly (a pay run reads communities, keys and payees) but each entity is written only by its owning service. `ProposalService` is the one service that calls others: it reads the key's remaining budget through `CommunityService` and turns a proposal into a run through `PayRunService.create` and `submit`, so runs are still written only by their own service. Add an orchestrator layer the day a flow genuinely spans more services than that.

## Domain model

Everything is keyed by the Discord guild ID: a guild is a community.

- **Community**: guild ID, name (read from Discord by `/rolepay setup`), network, treasury address, payout token, fee mode (`sponsor` or `fee_budget`, with a fee token), approver role ID (the Treasurer role the Discord layer checks), `requireSeparateApprover` (four eyes: a run's creator may not approve it; off by default), `aiProposals` (off by default) and an optional `proposerRoleId` (who may propose with AI besides the approver role). Changing the last two follows the same rule as the approver role. Changing the approver role, the fee mode or `requireSeparateApprover` needs a member who holds the CURRENT approver role (with none set yet, one who holds the new role): `canChangeApprovalRules` in the domain, enforced by `CommunityService` from the roles the caller passes, so Manage Server alone cannot make itself the approver.
- **SetupLink**: a short-lived (30 minute) link to the treasurer's setup page for one guild, issued by `/rolepay setup` to a member with Manage Server and the approver role. Only a fingerprint is stored. It carries the settings that first setup chose (name, payout token, fee mode, approver role), because the community cannot be registered until its treasury exists. It is not consumed on use (the page takes several steps); instead `bindTreasury` registers the treasury once and refuses any other address afterwards, and every later change also needs the treasury's own passkey session (checked by the web layer) or its signature on chain.
- **BotKey**: the bot's access key for one community. Address, sealed secret (encrypted by the KeyVault, bound to the community and key; `null` once the key is revoked or replaced, because Rolepay destroys a secret it will never use again), status (`pending_authorization`, `active`, `revoked`, `superseded`), and the policy the root signed: limit, period, expiry, optional recipient allowlist (`null` = none, the v1 default), optional fee budget.
- **Payee**: (guild, Discord user) to the address of their passkey account.
- **LinkToken**: a one-time registration link. Only an HMAC fingerprint of the token is stored, so a database reader cannot hijack a link and redirect someone's pay.
- **Run**: lines (1-based, each with payee, address, amount in bigint micro-units, and its bytes32 memo), total, status, actors and timestamps, attempts, the paying tx, a failure if any, and a version for compare-and-set.
- **Proposal**: a draft run the AI helped write (below): its lines with reasons and sources, held lines with why, people who are not registered, the criteria and amount rule (criteria mode) or the messages read (message mode), problems, the remaining key budget, a status (`open`, `run_created`, `discarded`) and an expiry a day out.

### Run state machine (`domain/run.ts`, pure)

```
draft --submit--> pending_approval --approve--> approved --start_attempt--> executing
executing --record_signed--> executing            (once per attempt)
executing --mark_paid--> paid
executing --mark_failed--> failed --start_attempt--> executing   (only if retryable)
failed --mark_paid--> paid | --mark_failed (partial_match, transfer_mismatch)--> failed
                                                  (the chain shows the run's memos after all)
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
3. **A deadline for every attempt.** Each attempt fixes `validBefore` (now + 120 s, an expiring nonce) before signing. Once chain time passes it, that tx can never land, and no new attempt starts before then.

`reconcile` never signs anything new. In order: look up the recorded tx hash; otherwise read the chain head, then search memo transfers from the first attempt's start block up to THAT head's block; if nothing is found and that head's timestamp has not passed the deadline, re-broadcast the same signed tx (or report `pending`); once it has passed with nothing on chain, mark the attempt `not_landed`, which makes a fresh attempt provably safe. Reading the head first matters: a search followed by a separate head read could miss a tx that landed between the two and call a paid run `not_landed`.

**A new attempt waits until the last one can no longer land.** Before a retry (and before cancelling a failed run), `execute` reads the chain head and, while its timestamp is not past the last attempt's validBefore plus the margin, returns `pending` with `retryAfter` (cancel returns `attempt_may_still_land`); the Discord job waits and asks `execute` again. This costs at most about 130 seconds, only after a failure, and it makes "never pay twice" independent of how a node's error text was classified: a broadcast misread as "rejected" while the tx sat in a mempool can still land, but never beside a second attempt. The fake chain models exactly that (`reject_but_keep_pending`, then `mine()`).

Then `execute` checks the chain once more, up to that head. If any of the run's memos are there it sends nothing and records what the chain shows: all of them, and the run is `paid` (receipts go out as usual); some, or the wrong amounts, and it becomes a failure a human must look at, and `execute` returns `chain_shows_payments`. `cancel` makes the same check on a failed run and refuses (`chain_shows_payments`), so a paid run never reads "cancelled" and a person following the UI is never led to pay it again. The failure messages in Discord say what was checked ("the chain shows nothing paid for this run"), never "nothing was paid".

| Crash point | State left behind | Recovery |
| --- | --- | --- |
| after opening the attempt, before signing | `executing`, no tx | nothing was signed; after the deadline, `not_landed`, then retry |
| after signing, before recording | `executing`, no tx | nothing was broadcast; same as above |
| after recording, before broadcast | `executing`, signed tx | reconcile re-broadcasts the same tx |
| after broadcast, before recording the result | `executing`, signed tx | reconcile finds the receipt or the memos, marks `paid` |

`PayRunService.recoverInFlight()` reconciles every `executing` run; the server runs it on boot and on an interval. The crash cases are tested with fakes, on a real SQLite file, and on Moderato.

Before signing, `execute` reads the key from the chain (`checkKeyForRun`): revoked, expired, expiring inside the submission window, or a run larger than the remaining limit all fail fast with a clear code. Without this, a revoked key fails late and vaguely (the spike saw about 110 s and "Missing or invalid parameters").

## Bot key lifecycle

1. `CommunityService.provisionBotKey` mints a fresh secp256k1 key, seals the secret, stores it as `pending_authorization`, and returns the exact authorisation for the root to sign (expiry, limits, scope). On the setup page the treasurer chooses the limit, the period and the expiry (and the fee budget in `fee_budget` mode).
2. **Production:** the browser sends a Tempo transaction from the treasury to the Account Keychain (`accessKey.authorize`), signed with the treasurer's passkey (WebAuthn P256) and sponsored on testnet; then `confirmBotKey` marks the key active once the chain shows it. **Dev, CLI and tests:** `authorizeBotKey({ root })` signs with an in-process `RootSigner` (`rootSignerFromPrivateKey`), then confirms (`pnpm dev:authorize-key`).
3. Rotation: "Replace the bot key" on the setup page sends ONE root transaction whose calls revoke every key still live on chain and then authorise the new one (`rotationCalls` in `client/keychain.ts`): atomic, one signature, one passkey prompt. `confirmBotKey({ keyAddress })` confirms the key the browser named (never "the newest pending one"), marks each other key revoked when the chain shows it so, superseded otherwise, and destroys their sealed secrets. A superseded key that is somehow still live on chain is listed on the setup page with its own Revoke button. The dev path (`authorizeBotKey({ root })`) revokes the old live keys with the in-process root before authorising the new one. A revoked key ID can never be re-authorised, so rotation always mints a fresh key.
4. Revoke: the setup page lists every key live on chain (`listKeys`), each with a Revoke button, and a pending key never hides the active one (`keyStatus` prefers the active key). It signs `accessKey.revoke` with the passkey and `confirmRevocation({ keyAddress })` marks that key revoked once the chain shows it (it never trusts the caller's word) and destroys its secret. Dev path: `revokeBotKey({ root })`. `keyStatus` and `listKeys` always read the chain.

A recurring limit's period is anchored at authorisation time, not at calendar months.

## Fees

- **`sponsor`**: the tx carries `feePayer: true` and is filled through a relay (`withRelay`). Testnet: the public sponsor `https://sponsor.moderato.tempo.xyz`. Mainnet: Tempo's hosted relay (API key) or a self-hosted relay; neither is configured yet, so mainnet defaults to no sponsor.
- **`fee_budget`**: the bot pays fees in a separate token (for example pathUSD) under its own small limit, authorised alongside the payout limit. The budget must cover gas limit times price up front (the keychain pre-charges, then nets back).
- `/rolepay setup fees:fee_budget` (or `fees:sponsor`) switches the mode; `setFeeMode` says when the active key has no fee budget for it, and the card asks the treasurer to authorise a new key with one on the setup page. A key with a fee budget keeps working after switching back to sponsored. Proven on Moderato by `packages/core/test/feeBudget.chain.test.ts` (fee paid in pathUSD, payout limit exact).
- "Sponsor down" is not automatic yet: a run fails as `rejected` (retryable), and switching the community to `fee_budget` is the fallback.

## Persistence

SQLite through Kysely and better-sqlite3 (`adapters/sqlite/`). Proposals are not a table: they are short-lived KeyValueStore records (see AI-proposed pay runs). The schema is portable on purpose: money as exact decimal text (Postgres `NUMERIC`), timestamps as ISO text, small nested values (key policy, attempts, failure) as JSON text. Moving to Postgres means a Kysely Postgres dialect plus the same migrations, with no service changes. Migrations live inline in `migrations.ts` and are append-only. Every row read is re-validated by the domain's Zod schema.

The repository contract (`test/support/repositoryContracts.ts`) runs against both the in-memory fakes and SQLite, so unit tests on fakes can be trusted.

**KeyValueStore** (`ports/keyValueStore.ts`, migration `0002_key_value`): small JSON records with an optional expiry, with atomic create-if-absent and read-and-delete, for state that is not a domain entity. The web layer keeps the passkey credentials, challenges and sessions there (through the Accounts SDK's `Handler.webAuthn`, keys under `webauthn:`), and the Discord layer keeps where a run's review message is and whether its receipts went out (`discord:`). The shape matches the Accounts SDK's `Kv`. `create` is one upsert guarded by expiry and `take` is one `DELETE ... RETURNING`, so both stay atomic on Postgres. Its own contract (`test/support/keyValueContract.ts`) runs against memory and SQLite.

## AI-proposed pay runs

**AI proposes, the protocol limits, a human approves.** A proposal is a draft. The model never approves, signs or pays: a proposal becomes money only through `PayRunService.create`, the treasurer's approval and the bot key's on-chain limit, all unchanged.

Two modes, both `ProposalService` methods:

- **Message mode** (`proposeFromMessages`): the model reads messages and the treasurer's instruction ("50 each, the indexer one 200, note: October bounties"). The source is the message a "Propose pay run" command targeted (it arrives with the interaction, so no intent is needed) or a channel's or thread's newest messages (at most 200, at most 31 days back; their text needs the Message Content intent). Before anything is sent, every user ID and mention becomes a token (`U1`, `U2`, ...) and every message `M1`, `M2`, ... (`domain/proposal/sources.ts`); the map back stays in code. Names typed as plain text cannot be recognised and are sent as written, which the setup card says.
- **Criteria mode** (`proposeFromCriteria`, "pay X to people who Y"): the model sees only the instruction (with roles, channels, people and message links as tokens) and the server's role and channel names by token, never members or messages. It returns a filter and an amount rule (`domain/proposal/raw.ts`); code checks them (`resolveCriteria`), reads what they need through the `ActivityReader` port, and runs them over the registered payees (`evaluateCriteria`). People the activity shows who match but are not registered are listed with a nudge to `/payee link`.

| Filter (v1, AND of all) | Read through |
| --- | --- |
| `hasRole` (any of), `lacksRole` (none of), `joinedBefore`, `joinedAfter` | one Get Guild Member per candidate (no GUILD_MEMBERS intent) |
| `messagesIn`, `activeDaysIn` (distinct days), `repliesIn` (replies to other people's messages) `{ channels, since, until, min }` | channel history, author IDs only (no Message Content intent; View Channel and Read Message History) |
| `reactedTo { message, emoji? }`, `mentionedIn { message }` (a message linked in the instruction) | the message and its reactions |
| `postedIn { thread }` | the thread's history |
| `paidInRun { run }`, `paidInLastRun` | Rolepay's own runs |
| `exclude { users }`, `excludeProposer` | |

Bounds, applied in code: at most 31 days back (a longer window is cut and the proposal says so), 10,000 messages per proposal across every channel it reads (a scan the bound stops is flagged), 5 channels, 100 unregistered people listed. The REST adapter pages history 100 at a time and waits when a rate-limit bucket empties. Not in v1: voice activity, reactions received, deep forum scans, OR between groups.

**Amount rules** (`domain/proposal/amounts.ts`, bigint micro-units throughout): `flat`, `perUnit` (per message, active day or reply, with an optional cap), `pool` (a total split by messages, active days, replies or equally), per-person overrides (they win over the rule and the cap) and an optional per-person cap. A pool is split by the largest-remainder rule: each person gets floor(total times weight, divided by the sum of weights) micro-units, and the few micro-units left over go one each to the largest remainders, ties broken by Discord user ID ascending, so the shares always add up to the total exactly and the same input always gives the same split. Overrides come out of a pool first; a pool is split among registered matches only. Message mode's "split 300 between the winners" uses the same rule.

**The checks, in code, whatever the model says** (`domain/proposal/proposal.ts`). A line is held (shown, left out of the run) when:

- every message backing it was written by the person it pays (`self_sourced`: "pay me 10,000");
- a message backing it tried to instruct the AI (`suspicious_source`; such messages are listed by author, never by text);
- no message backs it, or the model named someone who is not in the messages;
- its amount is not stated in the instruction (`amount_not_in_instruction`), or was said to come from a message and no message by someone else states it. Only numbers that read as amounts count: counts with their unit ("10 replies", "7 days"), dates, a year next to a month, ranks and references ("top 3", "#4521") are not amounts, so a line cannot borrow them;
- the person is listed twice, or the line alone is more than the bot key has left.

Then registration, the 50-line limit and the total against the key's remaining budget. Two problems block Create until an Edit: in criteria mode, an amount the instruction never stated (the instruction is the only text the model saw); in message mode, any amount taken from a message rather than the instruction, because anyone in the channel could have written it (the treasurer confirms it by submitting the lines). A message by a bot or webhook can back a line like anyone else's (bounty bots announce winners). Edit (the treasurer types `@user=amount` lines) makes the lines exactly what was typed. Create claims the proposal once (`ProposalRepository.claim`), so two clicks make one run; the claim is given back only if no run was created, so a failure after `create` (a write, the submit) can never lead to a second run.

**Who may propose.** The approver role, or the community's optional proposer role (`canPropose`), checked by core on every propose, edit, discard and create from the roles Discord signed into the interaction; the Discord layer checks first for a clear message, and the commands are hidden from members by default (`default_member_permissions`). The instruction is therefore trusted; the source messages are written by anyone in the channel and stay untrusted data. Proposing from a channel's history also needs the caller's own View Channel and Read Message History there (Discord sends their permissions in the picked channel), so the bot never reads a channel for someone who could not read it. AI proposals are off per community until a member with the approver role turns them on.

**The model** (`adapters/anthropic/`, behind the `RunProposer` port, a deterministic fake in `adapters/memory/fakeProposer.ts`): `claude-opus-5-5` (`ROLEPAY_AI_MODEL`) through the official SDK, one request per proposal, structured output in a JSON schema derived from the domain's Zod schemas (`outputSchema`), then validated with those same schemas. No `temperature` (Opus 5.5 rejects it); thinking cannot be disabled, so effort is `low` and `max_tokens` is 16,000 to leave room after thinking; Anthropic's server-side fallback (`fallbacks: "default"`) covers safety-classifier declines. Message text goes inside `<messages>` as JSON with `<` and `>` escaped, so no message can close its tag, and the system prompt says instructions inside it are never followed. A refusal, a cut-off or malformed answer, or an API error is a `could_not_propose` result, never a crash. Without `ANTHROPIC_API_KEY` there is no proposer and every AI command answers that AI is not configured.

**Storage and logs.** Proposals are KeyValueStore records (`adapters/kv/proposals.ts`) that expire after a day: no migration, and they move to Postgres with the store. The target of a message command is kept the same way for at most 15 minutes, until its modal is submitted. The server sweeps expired records off the disk on its recovery interval (`KeyValueStore.sweep`), so an abandoned form's message text does not stay. One `proposal` log line per attempt: mode, outcome, counts (messages sent or scanned, lines, held, unregistered), model, tokens, an estimated cost and latency; never message text, instructions, reasons or names.

## apps/server (Hono on Node)

The composition root (`src/main.ts`). It parses config (`src/config.ts`: the server's own `DISCORD_*`, `PUBLIC_URL` and `ROLEPAY_RP_ID`, `HOST`/`PORT` and bot-key defaults, plus core's `ROLEPAY_*` through `parseConfig`), opens the production adapters, creates the services and serves:

- `POST /discord/interactions`: the Discord interactions endpoint (HTTP interactions, no gateway bot).
- `GET /health`: `{ ok, network, jobsInFlight }`.
- `/claim/:token`, `/setup/:token`, `/webauthn/*`, `/assets/rolepay.js`: the web pages (`@rolepay/web`, below).
- The recovery sweep: `payRuns.recoverInFlight()` on start and every 30 seconds (`src/recovery.ts`), never two at once. Runs it settles are reported in Discord as part of the sweep (`createRecoveryNotifier`).

**The passkey domain is config only.** `PUBLIC_URL` is the public origin (the tunnel URL while developing); the WebAuthn rpId defaults to its host, or `ROLEPAY_RP_ID` names a parent domain. Config refuses what browsers refuse for passkeys: plain http off localhost, an IP address, a path, an rpId that is not the host or a parent of it. Moving to the production domain means changing these two values, and passkeys made on the old host do not carry over. The planned hosts are `https://demo.rolepay.app` (the testnet demo) and `https://app.rolepay.app` (mainnet), two servers with their own config and database.

```ts
const config = parseServerConfig(loadEnvironment())        // root .env, DB path anchored at the repo root
const { deps, kv, close } = await openRolepayAdapters(config.core)   // Anthropic too, when ANTHROPIC_API_KEY is set
const rest = new FetchDiscordRest({ botToken })
const rolepay = createRolepay({ ...deps, activity: new RestActivityReader(rest), proposalLog })
const passkeys = createPasskeys({ kv, origin: config.web.origin, rpId: config.web.rpId })
const web = { sessions: passkeys.sessions, passkeys: passkeys.handler, assets: bundledAssets() }
const server = composeServer({ config, rolepay, rest, clock: deps.clock, kv, web })
```

`composeServer` (`src/compose.ts`) is the wiring shared by `main.ts` and the tests: the tests pass in-memory adapters, a fake Discord and fake passkey sessions and drive the real Hono app over HTTP; the Playwright e2e passes the production set with real passkeys. Scripts: `pnpm register-commands`, and on testnet with `ROLEPAY_DEV_SHORTCUTS=true` the dev shortcut `pnpm dev:treasury` (print and fund a dev treasury whose key is in `.env`) and `pnpm dev:authorize-key <guildId>` (that in-process root signs the pending bot key). How to run it: `apps/server/README.md`.

## packages/web

The claim and setup pages, as an adapter over core like `packages/discord`: it calls core only through `@rolepay/core` services, and everything external is a port with a fake in `@rolepay/web/testing`.

```
app.ts       the Hono app: security headers (a strict CSP: our one script, the inline style by hash, connections only to us, the RPC and the sponsor; HSTS on https), same-origin POSTs only (CSRF), rate limits, /webauthn, /assets, the routes
rateLimit.ts TokenBucketLimiter, the in-memory RateLimiter
routes/      claim.ts (/claim/:token) and setup.ts (/setup/:token and its JSON endpoints)
views/       pure HTML builders; each page embeds a JSON config for the client
passkeys.ts  the Accounts SDK's Handler.webAuthn over core's KeyValueStore, and the session reader
assets.ts    the client bundle, built in memory with esbuild on first request and cached
client/      browser code (its own tsconfig with DOM types): main, claim, setup, passkey, tempo, keychain, dom
ports.ts     PasskeySessions, Assets, RateLimiter
```

**Why server-rendered HTML plus one client bundle**, not a separate `apps/web` with Vite: the pages are two forms, and passkeys bind to one origin, so the pages, the WebAuthn endpoints and the API must be served together anyway. Vite would add a second dev server and a proxy for the same result. esbuild is already installed (through tsx), bundles the Accounts SDK and viem for the browser in about a second, and `pnpm dev` keeps working with no build step. The bundle is about 1.5 MB (mostly viem's Tempo ABIs), served gzipped. A framework can come later behind the same routes if the pages grow.

**Passkeys.** The browser uses the Tempo Accounts SDK's `webAuthn` adapter (`Provider.create({ adapter: webAuthn({ auth: '/webauthn' }) })`) and `wallet_connect` to register or sign in. The ceremonies run against `Handler.webAuthn` on this server, which checks the origin and rpId from config, stores each credential's public key (WebAuthn sign-in does not return it, so returning users need the server to remember it) and issues a session cookie. The store is core's KeyValueStore, so credentials survive restarts and move to Postgres with the rest. The server derives the Tempo address from the session's public key; a page never tells the server an address.

**Claim.** `GET /claim/:token` describes the link; `POST /claim/:token` with a passkey session registers that session's address (`payees.register`, which consumes the link once).

**Setup.** `GET /setup/:token` (page), `GET /setup/:token/state` (community, key and chain state, who is signed in), `POST .../treasury` (bind the signed-in passkey as the treasury, registering the community the first time), `POST .../key` (provision a key with the chosen limit, period, expiry and fee budget; returns the authorisation), `POST .../key/confirm` and `POST .../key/revoked` (read the result from the chain). Everything after binding needs the session of the passkey that is the treasury, and the session must prove that passkey: one minted by `/webauthn/login` (an assertion, a signature over a server challenge with the stored public key; `withLoginProof` records it, by token hash), or the registration session that created the treasury (issued before the community existed). Any other registration session is refused with `sign_in_required`, because a registration with attestation "none" carries no signature: anyone could register the treasury's public key, which is public on chain once it signs, and get a session with its address. This keeps one prompt for creating the treasury and one for authorising the key right after.

**The page signs what the treasurer typed, not what the server says.** The WebAuthn prompt shows no transaction details, so the page builds the key authorisation itself (`buildAuthorization` in `client/keychain.ts`): the limit and period from the form, an expiry from the device clock ("expires after N days", sent to the server as `expiresAt` so both hold the same number), and one call scope, `transferWithMemo` on the payout token from the page config (plus the fee budget limit in fee_budget mode). It shows those exact values in plain words above the button, sends the form to `POST .../key`, takes only the key address from the answer, and refuses to sign (`authorizationMismatch`: "Nothing was signed") if the server's copy differs in any limit, period, expiry, target, selector or recipient. The Playwright e2e tampers the answer in the browser and checks that no passkey prompt happens. Caveat for the trust model: the page's JavaScript and config come from the same server that holds the bot key, so a fully compromised server could serve a different page. The fix for mainnet is to serve the setup page as an immutable bundle from a separate static origin the bot server cannot change.

The browser itself signs the keychain transactions (`client/tempo.ts`, with the passkey account, sponsored through the public sponsor on testnet; without a sponsor the treasury pays its own fee in its fee token). On testnet a faucet button funds the treasury.

**One passkey prompt per action.** Creating the treasury is one prompt (the new passkey), authorising the key is one, replacing it (revoke the old key and authorise the new one, in one transaction) is one, revoking it is one. The authorisation is a transaction from the root calling the keychain's `authorizeKey(keyId, signatureType, KeyRestrictions)` directly (`client/keychain.ts`), which a root key may do. viem's `accessKey.authorize` would instead sign a key authorization and then the transaction carrying it, two prompts for the same result on chain (the protocol runs the same `authorizeKey` for a signed key authorization). Revocation is viem's `accessKey.revokeSync`, already one transaction. The only second prompt is a sign-in: when the treasury's server session is live but this browser no longer remembers the passkey account (site data cleared), the page must sign in before it can sign, and says "Your device will ask twice" before the click. The Playwright e2e counts every WebAuthn call to hold these numbers, and reads the key's call scope back from the chain.

Layering is enforced by `packages/web/test/architecture.test.ts`: server code imports only `@rolepay/core`, hono, zod, the Accounts SDK server, `viem/tempo`, esbuild and node; client code imports only the Accounts SDK and viem; views are pure; nothing imports the fakes.

## packages/discord

The Discord adapter. It calls core only through `@rolepay/core` services; everything external is a port with an in-memory fake (`@rolepay/discord/testing`).

```
http/        Ed25519 verification (WebCrypto) and the endpoint as a fetch handler: Request in, Response out; each interaction ID is answered once (InteractionLog), so a replay inside the 5-minute window gets 409
app/         Zod parsing of interactions, the router, permission rules, outcome rendering
commands/    slash command definitions (JSON) and handlers
components/  the Approve, Cancel and Retry buttons
views/       pure builders from domain objects to Discord message payloads (soulform's transformers)
execution/   the in-process ExecutionQueue and the run executor job
adapters/    DiscordRest over fetch, MemberDirectory and core's ActivityReader over DiscordRest, KV stores
wire.ts      Zod schemas for Discord messages (message-command targets, history) and core's SourceMessage
ports.ts     DiscordRest, ExecutionQueue, MemberDirectory, RunNotices, InteractionLog, PendingSources
```

A handler is a thin route: parse options with Zod, check permissions, call a service, return an **outcome** (`reply`, `update`, `defer` or `choices`). Handlers never talk to Discord; `app/outcome.ts` renders the outcome. A `defer` answers at once ("thinking...") and finishes in the background, then edits the reply through the interaction webhook; a public deferral that fails is deleted and the error goes to the caller alone. Layering is enforced by `packages/discord/test/architecture.test.ts`: discord imports only `@rolepay/core` and `zod`; views import nothing with IO; handlers never reach adapters, the HTTP layer or the queue implementation.

| Command / component | Who | Service calls |
| --- | --- | --- |
| `/rolepay setup` | Manage Server (the treasury page link only with the approver role too) | first time: `issueSetupLink` with the chosen settings (nothing is registered until the passkey creates the treasury); after that `setName`, `setApproverRole`, `setFeeMode` (`fees`), `setRequireSeparateApprover` (`separate_approver`), `keyStatus`, and a fresh `issueSetupLink` for a treasurer. The three settings need the current approver role as well as Manage Server. Dev path (Moderato with `ROLEPAY_DEV_SHORTCUTS=true` only, and only for a member who holds the approver role; elsewhere the options are not registered and the handler refuses them): `treasury` registers an existing account and `new_key` provisions a key for `pnpm dev:authorize-key` |
| `/payee link` | anyone | `payees.issueLink`, replied ephemerally with `${PUBLIC_URL}/claim/${token}` |
| `/rolepay new` | Manage Server or approver | `payees.list` + member lookup for `role`, `payRuns.create`, `payRuns.submit`; the review embed is posted publicly |
| Approve | approver role only | `payRuns.approve({ actorCanApprove: true })`, then enqueue execution |
| Cancel | creator, Manage Server or approver | `payRuns.cancel` |
| Retry | approver role only | enqueue execution for an approved-but-unpaid or retryable failed run |
| `/rolepay status` | Manage Server or approver | `payRuns.get`, or `payRuns.list` + `communities.keyStatus` (deferred: reads the chain) |
| `/rolepay export` | Manage Server or approver | `payRuns.exportCsv` (default: the latest run), sent as a CSV attachment |
| Apps > Propose pay run (message command) | approver or proposer role, AI on | keeps the target message (`PendingSources`), answers with the instruction modal; the modal submit (deferred, ephemeral) calls `proposals.proposeFromMessages` |
| `/rolepay propose instruction: [source:] [since:]` | approver or proposer role, AI on | deferred, ephemeral: `proposals.proposeFromMessages` with `source` (a channel or thread, default 7 days), else `proposals.proposeFromCriteria` |
| Create pay run / Edit / Discard (on a proposal) | approver or proposer role | `proposals.createRun` (the review is then posted with a follow-up, Approve unchanged), the edit modal then `proposals.edit`, `proposals.discard` |
| `/rolepay setup ai_proposals: proposer_role:` | the current approver role | `communities.setAiProposals`; the setup card shows the AI state and the privacy line |

Decisions worth knowing:

- **Recipients.** `/rolepay new amount:<per person>` takes `role:` (every registered payee holding it), `users:` (mentions or IDs, `@bob=40` overrides the amount for one person), or both. Only registered payees can hold a line, so role filtering checks each registered payee with Get Guild Member, which needs **no privileged intent**. A List Guild Members implementation (which needs the GUILD_MEMBERS intent) can replace it behind the `MemberDirectory` port if a server ever has more payees than that is comfortable for.
- **Submit at create.** `/rolepay new` creates and submits in one go, so a run shown for review is `pending_approval`. Approve is one transition.
- **Approve answers with UPDATE_MESSAGE.** The review turns into "Approved, paying..." with no buttons inside the 3-second window (so nobody can click twice), the job is queued, and the job edits that same message with the result. A deferred update would leave the buttons live until the job finishes.
- **Permissions** are checked from the signed interaction (`member.roles`, `member.permissions`), never trusted from `default_member_permissions` alone, which only hides `/rolepay` from non-admins by default (admins can grant it to the Treasurer role in Server Settings > Integrations). Manage Server alone cannot approve, and cannot change who approves: that takes the current approver role.

### Execution

Discord requires an answer within 3 seconds; paying can take longer. Approve and Retry enqueue an `ExecutionJob` on the **`ExecutionQueue` port**:

```ts
type ExecutionJob = { kind: 'execute_run'; guildId: string; runId: string; reply: { applicationId: string; token: string }; channelId: string | null }
interface ExecutionQueue { enqueue(job: ExecutionJob): Promise<void> }
```

`InProcessExecutionQueue` runs jobs in the background, one at a time per run, different runs in parallel. The job carries the review message's channel and ID too. The job (`createRunExecutor`) remembers where that message is (the **`RunNotices` port**, on core's KeyValueStore so it survives a restart), then calls `payRuns.execute`; while the outcome is `pending` it waits until `retryAfter` (plus a second of slack) and calls `reconcile`, up to 12 checks, then hands over to the recovery sweep; on `concurrent_update` it follows the other worker with `reconcile` and never re-sends. It edits the message through the interaction webhook (tokens last 15 minutes; after that it posts to the channel as the bot), and once paid it DMs each payee a receipt through `DiscordRest`. Receipts go out at most once per run: whoever sends them first claims them in `RunNotices`. **After a restart** the job is gone, so the recovery sweep reports instead (`createRecoveryNotifier`): for each run it settled, it DMs the receipts (if nobody has) and edits the review message in its channel as the bot, or posts the result there if the message cannot be edited. A pre-flight failure (no active key, over the limit, revoked) leaves the run `approved` and shows the reason with a Retry button. Because `execute` is idempotent and the boot sweep recovers anything in flight, losing the in-process queue in a crash loses no money and pays nothing twice. A durable queue can replace it behind the same port.

## Testing

| Suite | Where | Runs |
| --- | --- | --- |
| Unit (domain, services on fakes) | `packages/core/src/**/*.test.ts` | `pnpm test` |
| Repository contract (memory + SQLite) | `packages/core/test/support/repositoryContracts.ts` | `pnpm test` |
| SQLite integration (temp file DB) | `packages/core/**/*.integration.test.ts` | `pnpm test` |
| Architecture guards | `packages/core/test/architecture.test.ts`, `packages/discord/test/architecture.test.ts` | `pnpm test` |
| Discord: verification, routing, every handler, views, executor, queue, REST adapter | `packages/discord/src/**/*.test.ts` (real core on in-memory fakes, fake Discord REST) | `pnpm test` |
| Web: claim and setup routes (fake passkey sessions), Handler.webAuthn over KeyValueStore, the keychain authorizeKey call the browser sends, the real client bundle builds, architecture guards | `packages/web/**/*.test.ts` | `pnpm test` |
| Server: config, routes, web pages, recovery loop and its Discord report, in-process end to end over signed HTTP | `apps/server/**/*.test.ts` | `pnpm test` |
| AI proposals: domain checks and the injection suite, ProposalService on fakes, the Anthropic adapter on recorded-style fixtures (valid, fallback, malformed, schema-invalid, refusal, cut off, HTTP errors), the activity reader on a fake Discord, handlers, views, signed message command and modal, and the in-process end to end (`apps/server/test/proposals.test.ts`) | `packages/*/src/**/proposal*`, `domain/proposal/`, `adapters/anthropic/` | `pnpm test` |
| AI, live, opt-in (three real calls: the demo with an injection beside it, the criteria demo, an instruction the filters cannot express) | `packages/core/test/anthropic.live.test.ts` | `ROLEPAY_AI_LIVE=true pnpm test:ai-live` |
| Chain, Moderato testnet, opt-in | `packages/core/test/*.chain.test.ts` (incl. fee budget), `apps/server/test/server.chain.test.ts` | `pnpm test:chain` |
| Browser, Moderato testnet, opt-in | `apps/server/e2e/passkeys.spec.ts` (Playwright, Chromium's virtual WebAuthn authenticator, the real server on `localhost`) | `pnpm test:e2e` |

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test:coverage` on every push and pull request: the default suite with v8 coverage over every source file, a per-package threshold a little below the current numbers, and a coverage table in the job summary. The opt-in suites (chain, browser, live AI) and secrets never run there.

The core chain test generates throwaway keys into the gitignored `.env`, funds the treasury from the faucet, and runs a full service-level pay run: register, key authorised with a limit, three payees via links, a 3-line sponsored batch, reconcile from memo events, idempotent re-execute, crash recovery from a restarted process, an over-limit run refused before signing, revoke, CSV export. The server chain test reuses those keys and drives the whole Discord flow through the signed HTTP endpoint with production adapters and a fake Discord REST: setup, links claimed on the dev page, `/rolepay new`, Approve, one sponsored batch, receipts. Both refuse any chain but Moderato.

The in-process end to end (`apps/server/test/e2e.test.ts`) does the same over HTTP with in-memory adapters, and also covers a crash between approval and execution (status offers Retry; still one payment), a process that dies while a payment is in flight (the next process's sweep finishes it, updates the message and sends the receipts once), and the production setup through Discord and the setup endpoints.

The browser e2e proves the passkey paths for real: a recipient creates a passkey on the claim page and a returning one signs in with it; a treasurer creates the treasury with a passkey, funds it from the faucet, authorises the bot key with the passkey (a WebAuthn-signed keychain transaction on Moderato), the bot pays a run from that account, the passkey replaces the key in one prompt (the old key reads revoked on chain), and the passkey revokes the new key.

## Renamed from payrun

The product was called payrun while it was built. What was already stored or posted under that name keeps working, and these stay as they are on purpose:

- **On chain.** The memo layout and its `"PR"` prefix bytes are unchanged, so earlier runs still reconcile.
- **The vault.** The HKDF labels `payrun:seal` and `payrun:fingerprint` derive the keys that open sealed bot keys and match link tokens. They never change; a known-answer test in `adapters/crypto/crypto.test.ts` holds them.
- **The database file.** The default is `rolepay.db`, but the server keeps using the repo-root `payrun.db` when it exists and `ROLEPAY_DB_PATH` is unset (`apps/server/src/env.ts`).
- **Settings.** Every `PAYRUN_X` is still read as `ROLEPAY_X` when that is unset or blank (`withDeprecatedEnvNames` in `config/env.ts`), and the server logs the deprecated names in use.
- **Discord.** Run buttons are now `rolepay:<action>:<runId>`; buttons already posted carry `payrun:` and still decode. The slash command changed from `/payrun` to `/rolepay`, so the commands are registered again.
- **Sessions.** The passkey-login record keeps its `payrun:passkey-login:` key in the KeyValueStore.

## Known limits and open decisions

- At most 50 lines per run (Tempo's 30M gas cap per tx at about 300k gas per first transfer to a fresh address, with a 2x margin). Raise only after a chain test at the new size.
- One active bot key per community; replacing it revokes the old one on chain. Payees are per community (the same person in two guilds registers twice).
- The run creator may also approve it (if they hold the approver role), by default: many small communities have one treasurer who also builds the runs, and refusing them would block the product. A community that wants four eyes runs `/rolepay setup separate_approver:true` (a treasurer only), and then `approve` refuses the creator with `creator_cannot_approve`.
- A change of approver role is answered ephemerally to the treasurer who made it; nothing is posted publicly yet. Moving it behind the treasury passkey on the setup page would make it as strong as a key change.
- No recipient allowlist by default; adding a payee to an allowlist needs a root-signed `setAllowedCalls` (a passkey prompt), which is why it is off in v1.
- Mainnet: guarded by `ROLEPAY_ALLOW_MAINNET=true`; no sponsor configured, so communities there use `fee_budget` (`/rolepay setup fees:fee_budget fee_token:<address>`, or `ROLEPAY_FEE_TOKEN`), and the treasurer's own transactions on the setup page pay their fee in the fee token. A self-hosted relay (`Handler.relay`) would sponsor them.
- One amount per person in `/rolepay new` (with per-user overrides). A CSV or modal for many different amounts is later.
- Receipts are best effort: one that fails (closed DMs) is counted, not retried, and never sent twice.
- The treasury and payout token cannot be changed after registration (no service method for it yet).
- **The passkey domains.** Planned: `demo.rolepay.app` (the testnet demo for judges) and `app.rolepay.app` (mainnet), each with its own rpId (the host by default, `ROLEPAY_RP_ID` to override). Passkeys bind to the rpId for good, so the demo's passkeys never work on mainnet; a quick tunnel host is fine for testing only.
- A setup link is short-lived rather than single-use (see SetupLink). A recipient's claim link is single-use.
- The setup page's code is served by the bot server itself (see "The page signs what the treasurer typed"): a separate static origin for it is a mainnet prerequisite.
- The setup page signs with whatever passkey account the Accounts SDK has signed in on that browser; if it is not the treasury, the page asks for the treasury passkey and the server refuses the others anyway.
- AI proposals: the model can misread an instruction; the checks hold what they can prove wrong (sources, amounts, budget) and the treasurer reads the rest. Plain-text names in messages reach Anthropic as written. A pool (and a message-mode split) is shared among registered matches only. Proposals expire after a day. Criteria mode counts activity in any channel the bot can read, whoever proposes: proposers are the approver role or a role the approver chose, and only counts come back, never text.
- The WebAuthn endpoints are open (anyone can register a passkey with the server; a registration session never counts as the treasury's passkey, see Setup). POSTs to /webauthn, /claim and /setup are rate limited behind the `RateLimiter` port (`defaultRateLimits` in `apps/server/src/compose.ts`: per client, by the last X-Forwarded-For hop or, behind Fly, by `Fly-Client-IP` (`ROLEPAY_CLIENT_IP_HEADER`), and per endpoint group overall), in memory per process. Expired key-value rows read as absent and are swept on the recovery interval; request bodies have no size cap yet.
