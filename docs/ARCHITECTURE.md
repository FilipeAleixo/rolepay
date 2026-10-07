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
packages/web         @rolepay/web: the claim and treasurer setup pages, WebAuthn ceremonies, the client bundle, the web dashboard
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
services/      CommunityService, PayeeService, PayRunService, ProposalService,
               PolicyService, SchedulerService, AuditService                     (the ONLY public interface)
   |  uses
   v
domain/        pure: Zod schemas, types, state machine, money, memo, reconcile, CSV, proposal/, policy/
ports/         interfaces: PayoutChain, *Repository (incl. Policy, PolicyRun), AuditLog, KeyValueStore,
               KeyVault, Clock, IdGenerator, RunProposer, ActivityReader, ProposalLog
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

**Public surface.** `@rolepay/core` exports `createRolepay(deps)` (returns the services: `communities`, `payees`, `payRuns`, `proposals`, `policies`, `scheduler`, `audit`), the services' types and input schemas, domain types and schemas, port types, config and constants. `@rolepay/core/adapters` exports the implementations, for composition roots only. `openRolepayAdapters(parseConfig(process.env))` opens the production set (SQLite file, AES vault, Tempo chain, random IDs, system clock) and returns `{ deps, kv, close }`: `kv` is the KeyValueStore in the same database file.

**Results, not throws.** Every expected failure is a value: `{ ok: false, error: { code: 'snake_case', ... } }`. Services throw only for the unexpected (a database or RPC outage), which the caller treats as "try again".

**No orchestrator layer.** soulform-app puts multi-service flows in orchestrators. Rolepay has four services and two real flows, so services read the repositories they need directly (a pay run reads communities, keys and payees) but each entity is written only by its owning service. `ProposalService` is the one service that calls others: it reads the key's remaining budget through `CommunityService` and turns a proposal into a run through `PayRunService.create` and `submit`, so runs are still written only by their own service. `PolicyService` and `SchedulerService` follow the same rule: they read what they need, make runs only through `PayRunService.create`, `submit`, `approve` and `execute`, read the key budget through `CommunityService`, and share one criteria runner (`services/criteriaRunner.ts`) with criteria mode, so a policy is evaluated by exactly the code a proposal is. Add an orchestrator layer the day a flow genuinely spans more services than that.

## Domain model

Everything is keyed by the Discord guild ID: a guild is a community.

- **Community**: guild ID, name (read from Discord by `/rolepay setup`), network, treasury address, payout token, fee mode (`sponsor` or `fee_budget`, with a fee token), approver role ID (the Treasurer role the Discord layer checks), `requireSeparateApprover` (four eyes: a run's creator may not approve it; off by default), `aiProposals` (off by default) and an optional `proposerRoleId` (who may propose with AI besides the approver role). Changing the last two follows the same rule as the approver role. Changing the approver role, the fee mode or `requireSeparateApprover` needs a member who holds the CURRENT approver role (with none set yet, one who holds the new role): `canChangeApprovalRules` in the domain, enforced by `CommunityService` from the roles the caller passes, so Manage Server alone cannot make itself the approver.
- **SetupLink**: a short-lived (30 minute) link to the treasurer's setup page for one guild, issued by `/rolepay setup` to a member with Manage Server and the approver role. Only a fingerprint is stored. It carries the settings that first setup chose (name, payout token, fee mode, approver role), because the community cannot be registered until its treasury exists. It is not consumed on use (the page takes several steps); instead `bindTreasury` registers the treasury once and refuses any other address afterwards, and every later change also needs the treasury's own passkey session (checked by the web layer) or its signature on chain.
- **BotKey**: the bot's access key for one community. Address, sealed secret (encrypted by the KeyVault, bound to the community and key; `null` once the key is revoked or replaced, because Rolepay destroys a secret it will never use again), status (`pending_authorization`, `active`, `revoked`, `superseded`), and the policy the root signed: limit, period, expiry, optional recipient allowlist (`null` = none, the v1 default), optional fee budget.
- **Payee**: (guild, Discord user) to the address of their passkey account.
- **LinkToken**: a one-time registration link. Only an HMAC fingerprint of the token is stored, so a database reader cannot hijack a link and redirect someone's pay.
- **Run**: lines (1-based, each with payee, address, amount in bigint micro-units, and its bytes32 memo), total, status, actors and timestamps, attempts, the paying tx, a failure if any, and a version for compare-and-set.
- **Policy**: a standing rule (see Standing policies): the original instruction next to the rule the AI compiled from it once (criteria and amount plan), the schedule, caps, mode (`propose` or `autopilot`) and veto window, status (`draft`, `active`, `paused`, `archived`), the current version and who approved it when, and a `rev` for compare-and-set. **PolicyVersion**: every version of the definition, kept for good, with its author, approval or discard. **PolicyRun**: one run of a policy for one period (unique per policy and period), linked to the pay run it made, with what code computed, the hold reason if any, the veto and the release. **AuditEvent**: the append-only audit stream (below).
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

The repository contract (`test/support/repositoryContracts.ts`) runs against both the in-memory fakes and SQLite, so unit tests on fakes can be trusted; the policy repositories and the audit log have their own (`test/support/policyRepositoryContract.ts`).

Migration `0006_policies` adds `policies`, `policy_versions` (primary key policy and version), `policy_runs` (a UNIQUE constraint on policy and period key: the idempotency of the scheduler rests on it) and `audit_events` (an integer `seq` row ID, an identity column on Postgres). Nested values (the compiled rule, schedule, caps, lines) are JSON text with tagged bigints and dates, re-validated on every read.

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

**The model** (`adapters/anthropic/`, behind the `RunProposer` port, a deterministic fake in `adapters/memory/fakeProposer.ts`): `claude-opus-5-5` (`ROLEPAY_AI_MODEL`) through the official SDK, one request per proposal, structured output in a JSON schema derived from the domain's Zod schemas (`outputSchema`), then validated with those same schemas. The API refuses (HTTP 400) a schema with more than 16 union-typed parameters, and each nullable field is one, so criteria mode's answer has no nulls: optional values are empty strings, and the counting windows and the message or thread conditions are lists (`activity`, `anchors`) that `resolveCriteria` maps to the filters above; a test keeps every mode's schema at 12 or fewer. No `temperature` (Opus 5.5 rejects it); thinking cannot be disabled, so effort is `low` and `max_tokens` is 16,000 to leave room after thinking; Anthropic's server-side fallback (`fallbacks: "default"`) covers safety-classifier declines. Message text goes inside `<messages>` as JSON with `<` and `>` escaped, so no message can close its tag, and the system prompt says instructions inside it are never followed. A refusal, a cut-off or malformed answer, or an API error is a `could_not_propose` result, never a crash. Without `ANTHROPIC_API_KEY` there is no proposer and every AI command answers that AI is not configured. **A daily cap** keeps a public server from running up the bill: the production proposer is wrapped in `DailyCappedProposer` (`adapters/kv/proposerDailyCap.ts`), which lets at most `ROLEPAY_AI_DAILY_CAP` model calls (default 50) through per UTC day across every community on the server. Each call takes a numbered slot for the day with the KeyValueStore's atomic create-if-absent, so a restart keeps the count and concurrent calls never share a slot; failed calls count, because they are billed. Past the cap the model is not called and the answer is `could_not_propose` with reason `daily_cap` ("after midnight UTC, or `/rolepay new`").

**Storage and logs.** Proposals are KeyValueStore records (`adapters/kv/proposals.ts`) that expire after a day: no migration, and they move to Postgres with the store. The target of a message command is kept the same way for at most 15 minutes, until its modal is submitted. The server sweeps expired records off the disk on its recovery interval (`KeyValueStore.sweep`), so an abandoned form's message text does not stay. One `proposal` log line per attempt: mode, outcome, counts (messages sent or scanned, lines, held, unregistered), model, tokens, an estimated cost and latency; never message text, instructions, reasons or names.

## Standing policies (the agent treasurer)

**AI writes the rule once. Humans approve it. Code runs it. The chain caps it.**

A policy is a standing rule, for example "every Monday: 1 USDC per answered question in #help, max 50 a week each, for Mods". Code is in `domain/policy/` (pure), `services/policyService.ts`, `services/schedulerService.ts`, `services/policyEvaluation.ts` and `services/auditTrail.ts`.

### Lifecycle

1. **Create** (`PolicyService.create`, from `/rolepay policy new` or the dashboard): the model compiles the instruction ONCE with criteria mode (the same request, prompt, checks and `resolveCriteria` as `/rolepay propose`, so the same daily cap and the same "the model never sees members" rule). The original instruction is kept next to the compiled filter and amount plan. The schedule and the caps are options, never parsed from the text. The policy is a draft (version 1). Who may write: the approver role or the proposer role, with AI proposals on.
2. **Preview** (`preview`): the compiled rule in plain words, the exact filter, and who it applies to right now: the period in progress (since the last occurrence) is run through the rule by code; each person comes with their counts, why they match and what the next run would pay; people who match but are not registered, and near misses (they failed only a count and had at least one), are listed apart; the total is compared with the bot key's remaining budget and the policy cap.
3. **Approve** (`approve`): only a member holding the CURRENT approver role, for the version they saw (`version_mismatch` otherwise). Recorded with who and when on the policy and its version. Blocked while the rule uses an amount the instruction does not state (rewrite the instruction). With four eyes on (`requireSeparateApprover`), the author cannot approve their own rule or switch its autopilot on.
4. **Edit** (`edit`): a new version (any of name, instruction, schedule, caps; a new instruction is compiled again). The policy goes back to draft (it stops running), autopilot is switched off, and the new version needs a new approval. `discard` of an edit restores the last approved version, paused; of a new draft, archives it.
5. **Run** (`SchedulerService.tick`, below) with no AI at runtime.
6. **Pause, resume, mode, veto window, archive, veto**: the current approver role only. Resuming never backfills the periods it missed.

### Schedules and periods

Weekly (weekday and hour) or monthly (day and hour) in an IANA timezone, UTC by default (`domain/policy/schedule.ts`). Local times are turned into instants with the runtime's timezone database: an hour that does not exist (the spring gap) runs when the gap ends, and one that happens twice runs the first time. A day past the end of a short month runs on its last day. A run covers one period, from the previous occurrence to its own, at most 31 days back (the criteria bound); the compiled rule's counting windows are moved onto that period (`windowedCriteria`), everything else (roles, anchors, exclusions) stays as compiled. Only the latest occurrence after the policy became active is run: a server that was down for two weeks makes one run, not a backlog.

### Modes, the veto window and autopilot

- **propose** (the default): each run is created and submitted, then waits for the normal one-tap approval (the existing review embed).
- **autopilot** (an explicit switch by an approver on an approved policy): the run is posted with "pays at <time> unless vetoed" and a Veto button, and pays after the veto window (default 24 h, at least 1 h; a server with the testnet dev shortcuts allows 1 minute for manual tests). The scheduler approves it in the name of the approver who switched autopilot on, through `PayRunService.approve`, then `execute`; the bot key's on-chain limit caps it like any run. Before approving it checks again, every time: the policy is still active, still on autopilot and at the version that made the run, the community's approver role is the one recorded when autopilot was switched on, and that person still holds it (one Get Guild Member through the ActivityReader). If any of these fail, autopilot stops: the run stays pending for the normal approval and the message says why.
- **The veto** (`PolicyService.veto`, the approver role): cancels the run, records who and when. It counts until the run is released: the release takes the run from `scheduled` by compare-and-set, the veto takes it the same way, and exactly one wins. The domain itself refuses a release before `executeAfter` (`movePolicyRun`), so no scheduler bug can pay early.

### Guardrails

- A cap per run (a run over it is held whole) and per person (each line is cut to it, overrides included, after the rule).
- A run that would exceed what the bot key has left, has no active key, or has more people than one run holds is **held whole and explained** (`runGuards`: the code and the numbers), never partly paid. A held run makes no pay run. At execution the usual pre-flight (`checkKeyForRun`) runs again: a key revoked or spent during the veto window holds the approved run (Retry in Discord), and the batch is atomic anyway.
- Revoking the key stops everything (no active key: held). Pausing stops new runs and autopilot releases.
- The recovery sweep reconciles autopilot runs left executing like any run; the scheduler's own records survive restarts (below).

### One run per policy per period

- The scheduler claims a period by inserting the PolicyRun: the repository's unique key on (policy, period key) lets exactly one insert succeed, so a double tick, a restart or a second instance does nothing.
- The pay run's ID is chosen at the claim and stored with it (`PayRunService.create(input, { runId })`): if the process dies after the run exists but before the PolicyRun links it, whoever carries on finds that run and never makes a second one.
- Work in progress (`generating`, `releasing`) holds a lease (5 minutes); another instance takes it over only once it has run out. Every move is a compare-and-set on `rev`.
- Releasing calls `approve` and `execute`, both idempotent behind the run's own compare-and-set, so never-pay-twice holds as for any run.

```
PolicyRun: generating --> proposed | scheduled | held | empty
           scheduled --> vetoed | releasing --> released | held | cancelled
```

### The audit stream

Every policy and run event, append-only (`AuditLog` port, `audit_events` table): `policy.created`, `compiled`, `edited`, `approved`, `discarded`, `paused`, `resumed`, `mode_changed`, `archived`; `policy_run.generated`, `held`, `empty`, `vetoed`, `released`, `cancelled`; and every pay run's `run.created`, `submitted`, `approved`, `cancelled`, `executing`, `paid`, `failed` (written by `PayRunService`, best effort so an audit outage never fails a payment step). Each event has the actor (the Discord user, or null for Rolepay itself), the time, the policy and version, the policy run and the pay run (a pay run made by a policy carries its policy), and details that are codes, amounts, counts and IDs, never anyone's words (instructions and names stay on their own records).

### Service API for the dashboard

All through `createRolepay(...)`; every method takes `guildId` and never returns another community's data. Writes take the caller as `{ guildId, actor, actorRoleIds }` (the roles the dashboard re-read from Discord for that request) and re-check them; expected failures are `{ ok: false, error: { code } }`.

| Call | Returns | Notes |
| --- | --- | --- |
| `policies.list({ guildId })` | `{ policy, nextRunAt, lastRun }[]`, newest first | `nextRunAt` for active ones |
| `policies.detail({ guildId, policyId, runs? })` | `{ policy, versions, runs, lastRun, nextRunAt, rule }` | `versions` oldest first (author, approval, discard); `rule` is the plain-words lines |
| `policies.get({ guildId, policyId })` | `Policy` | the original `instruction` and the `compiled` filter (the expandable JSON) |
| `policies.preview({ guildId, policyId })` (alias `listMatches`) | `{ window, nextRunAt, matches, nearMisses, total, remaining, problems, rule, scans }` | `matches[]`: `discordUserId`, `registered`, `metrics`, `amount`, `capped`, `reasons` (structured) and `reasonText`; reads Discord and the chain, never the model |
| `policies.nextRuns({ guildId, limit? })` | `{ policyId, name, mode, at }[]` | soonest first |
| `policies.listRuns({ guildId, policyId?, statuses?, limit? })` | `PolicyRun[]` | newest period first; lines, unregistered, total, hold, veto, release |
| `policies.getRun({ guildId, policyRunId })`, `policies.runFor({ guildId, runId })` | `PolicyRun`; `{ policy, policyRun } \| null` | which policy and version made a pay run |
| `policies.create(...)`, `edit(...)` | `Policy` | writer: approver or proposer role; calls the model |
| `policies.approve({ ..., policyId, version })`, `discard`, `pause`, `resume`, `archive` | `Policy` | approver role (discard: also the author) |
| `policies.setMode({ ..., policyId, mode, vetoWindowMinutes? })` | `Policy` | approver role |
| `policies.veto({ ..., policyRunId })` | `{ policyRun, run }` | approver role |
| `audit.list({ guildId, types?, actor?, policyId?, runId?, since?, until?, before?, limit? })` | `{ events, next }` | newest first; `next` is the `before` cursor for the next page (limit 1 to 500) |
| `audit.exportCsv({ guildId, ...filters })` | `{ filename, csv, count }` | oldest first, formulas defused |
| `payRuns.list`, `payRuns.get`, `payRuns.exportCsv`, `communities.keyStatus`, `payees.list` | as before | runs, payees, treasury and key for the other pages |

Error codes: `policy_not_found`, `not_permitted`, `community_not_found`, `policy_not_draft`, `version_mismatch`, `policy_blocked`, `creator_cannot_approve`, `invalid_veto_window`, `policy_not_approved`, `policy_archived`, `policy_not_active`, `policy_not_paused`, `concurrent_update`, `policy_run_not_found`, `not_scheduled`, `too_late`, `invalid_input`, and from compiling `ai_not_configured`, `ai_disabled`, `could_not_propose`, `criteria_unclear`, `criteria_invalid`, `cannot_read`. Hold codes on a PolicyRun: `over_budget`, `over_policy_cap`, `too_many_lines`, `no_active_key`, the key checks (`key_revoked`, `insufficient_limit`, ...), `policy_not_active`, `autopilot_off`, `policy_changed`, `approver_changed`, `creator_cannot_approve`, `cannot_read`.

## apps/server (Hono on Node)

The composition root (`src/main.ts`). It parses config (`src/config.ts`: the server's own `DISCORD_*`, `PUBLIC_URL` and `ROLEPAY_RP_ID`, `HOST`/`PORT` and bot-key defaults, plus core's `ROLEPAY_*` through `parseConfig`), opens the production adapters, creates the services and serves:

- `POST /discord/interactions`: the Discord interactions endpoint (HTTP interactions, no gateway bot).
- `GET /health`: `{ ok, network, jobsInFlight }`.
- `/claim/:token`, `/setup/:token`, `/webauthn/*`, `/assets/rolepay.js`: the web pages (`@rolepay/web`, below).
- `/dashboard`, `/auth/discord`: the web dashboard (below). `src/dashboard.ts` wires it: the bot's REST client as the member view, Discord OAuth2 when `ROLEPAY_DISCORD_CLIENT_SECRET` is set, and the policy seam.
- The recovery sweep: `payRuns.recoverInFlight()` on start and every 30 seconds (`src/recovery.ts`), never two at once. Runs it settles are reported in Discord as part of the sweep (`createRecoveryNotifier`).
- The policy scheduler: `scheduler.tick()` on start and every `ROLEPAY_SCHEDULER_INTERVAL_SECONDS` (30 by default) on the same non-overlapping loop (`src/scheduler.ts`), then `createPolicyNotifier` posts what it did. A second instance on the same database is safe (one run per policy per period, compare-and-set releases).

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
app.ts       the Hono app: security headers (a strict CSP: our one script, the inline styles by hash, connections only to us, the RPC and the sponsor; HSTS on https), same-origin POSTs only (CSRF), rate limits (public POSTs, and every request of the Discord sign-in), /webauthn, /assets, the routes
rateLimit.ts TokenBucketLimiter, the in-memory RateLimiter
routes/      claim.ts (/claim/:token) and setup.ts (/setup/:token and its JSON endpoints)
views/       pure HTML builders; each page embeds a JSON config for the client
passkeys.ts  the Accounts SDK's Handler.webAuthn over core's KeyValueStore, and the session reader
assets.ts    the client bundle, built in memory with esbuild on first request and cached
client/      browser code (its own tsconfig with DOM types): main, claim, setup, passkey, tempo, keychain, dom
ports.ts     PasskeySessions, Assets, RateLimiter
dashboard/   the web dashboard (its own section below)
```

**Why server-rendered HTML plus one client bundle**, not a separate `apps/web` with Vite: the pages are two forms, and passkeys bind to one origin, so the pages, the WebAuthn endpoints and the API must be served together anyway. Vite would add a second dev server and a proxy for the same result. esbuild is already installed (through tsx), bundles the Accounts SDK and viem for the browser in about a second, and `pnpm dev` keeps working with no build step. The bundle is about 1.5 MB (mostly viem's Tempo ABIs), served gzipped. A framework can come later behind the same routes if the pages grow.

**Passkeys.** The browser uses the Tempo Accounts SDK's `webAuthn` adapter (`Provider.create({ adapter: webAuthn({ auth: '/webauthn' }) })`) and `wallet_connect` to register or sign in. The ceremonies run against `Handler.webAuthn` on this server, which checks the origin and rpId from config, stores each credential's public key (WebAuthn sign-in does not return it, so returning users need the server to remember it) and issues a session cookie. The store is core's KeyValueStore, so credentials survive restarts and move to Postgres with the rest. The server derives the Tempo address from the session's public key; a page never tells the server an address.

**Claim.** `GET /claim/:token` describes the link; `POST /claim/:token` with a passkey session registers that session's address (`payees.register`, which consumes the link once).

**Setup.** `GET /setup/:token` (page), `GET /setup/:token/state` (community, key and chain state, who is signed in), `POST .../treasury` (bind the signed-in passkey as the treasury, registering the community the first time), `POST .../key` (provision a key with the chosen limit, period, expiry and fee budget; returns the authorisation), `POST .../key/confirm` and `POST .../key/revoked` (read the result from the chain). Everything after binding needs the session of the passkey that is the treasury, and the session must prove that passkey: one minted by `/webauthn/login` (an assertion, a signature over a server challenge with the stored public key; `withLoginProof` records it, by token hash), or the registration session that created the treasury (issued before the community existed). Any other registration session is refused with `sign_in_required`, because a registration with attestation "none" carries no signature: anyone could register the treasury's public key, which is public on chain once it signs, and get a session with its address. This keeps one prompt for creating the treasury and one for authorising the key right after.

**The page signs what the treasurer typed, not what the server says.** The WebAuthn prompt shows no transaction details, so the page builds the key authorisation itself (`buildAuthorization` in `client/keychain.ts`): the limit and period from the form, an expiry from the device clock ("expires after N days", sent to the server as `expiresAt` so both hold the same number), and one call scope, `transferWithMemo` on the payout token from the page config (plus the fee budget limit in fee_budget mode). It shows those exact values in plain words above the button, sends the form to `POST .../key`, takes only the key address from the answer, and refuses to sign (`authorizationMismatch`: "Nothing was signed") if the server's copy differs in any limit, period, expiry, target, selector or recipient. The Playwright e2e tampers the answer in the browser and checks that no passkey prompt happens. Caveat for the trust model: the page's JavaScript and config come from the same server that holds the bot key, so a fully compromised server could serve a different page. The fix for mainnet is to serve the setup page as an immutable bundle from a separate static origin the bot server cannot change.

The browser itself signs the keychain transactions (`client/tempo.ts`, with the passkey account, sponsored through the public sponsor on testnet; without a sponsor the treasury pays its own fee in its fee token). On testnet a faucet button funds the treasury.

**One passkey prompt per action.** Creating the treasury is one prompt (the new passkey), authorising the key is one, replacing it (revoke the old key and authorise the new one, in one transaction) is one, revoking it is one. The authorisation is a transaction from the root calling the keychain's `authorizeKey(keyId, signatureType, KeyRestrictions)` directly (`client/keychain.ts`), which a root key may do. viem's `accessKey.authorize` would instead sign a key authorization and then the transaction carrying it, two prompts for the same result on chain (the protocol runs the same `authorizeKey` for a signed key authorization). Revocation is viem's `accessKey.revokeSync`, already one transaction. The only second prompt is a sign-in: when the treasury's server session is live but this browser no longer remembers the passkey account (site data cleared), the page must sign in before it can sign, and says "Your device will ask twice" before the click. The Playwright e2e counts every WebAuthn call to hold these numbers, and reads the key's call scope back from the chain.

Layering is enforced by `packages/web/test/architecture.test.ts`: server code imports only `@rolepay/core`, hono, zod, the Accounts SDK server, `viem/tempo`, esbuild and node; client code imports only the Accounts SDK and viem; views (the dashboard's too) are pure; nothing imports the fakes.

## The web dashboard (`packages/web/src/dashboard/`)

Per community: Overview, Runs, Payees, Policies and the Audit log, read only for members, with actions for the approver (Treasurer) role. It lives in `packages/web` because it shares the origin, the security headers (CSP, HSTS, no framing), the rate limits and the same-origin check with the claim and setup pages. It has no script at all (forms post and redirect back, `<details>` expands), so the CSP only adds its stylesheet's hash, and there is no bundle to grow.

```
index.ts         dashboardRoutes: the routes below and the generic error page
kit.ts           what routes share: DashboardDeps, the session store, cookies, the member cache, html and redirect, safeNext
ports.ts         DiscordOAuth (sign-in) and GuildMembers (the bot's view of members)
policyPort.ts    PolicyPort and AuditPort: the policy seam (below)
sessions.ts      sessions and pending sign-ins over core's KeyValueStore, tokens kept as SHA-256 only, CSRF tokens
cookies.ts       HttpOnly, SameSite=Lax, Secure and __Host- prefixed on https
discordOAuth.ts  FetchDiscordOAuth: code exchange with PKCE, /users/@me and /users/@me/guilds, then revoke the token
members.ts       CachedGuildMembers: roles trusted a minute for pages and read fresh for actions; names cached ten minutes
access.ts        communityAccess (who may see a page) and actionAccess (CSRF, fresh roles, approver role)
routes/          auth (sign in, callback, sign out, home), community (overview, runs, payees), policies, audit
views/           pure HTML builders: layout and stylesheet, formatting, one per page, a line diff for policy versions
```

**Sign-in with Discord.** OAuth2 authorization code with PKCE (S256) and state, scopes `identify guilds`, the client ID is the app ID and the secret is `ROLEPAY_DISCORD_CLIENT_SECRET` (unset: every page says sign-in is not configured). `/auth/discord` keeps the PKCE verifier and where to return under a hash of a fresh state for ten minutes and puts the state in an HttpOnly cookie. The callback requires the query's state to equal this browser's cookie (otherwise anyone could send a victim a callback link and sign them into the attacker's account), takes the pending sign-in once, exchanges the code with the verifier, reads the user and their guilds and revokes the token: Rolepay keeps no Discord token. It then mints a new session, never one the browser brought (no session fixation; a session the browser carried is ended), kept in the KeyValueStore under a SHA-256 of its random token for eight hours with its own CSRF token. `next` only returns to a `/dashboard` page on this origin. Sign out is a POST with the CSRF token and deletes the session on the server.

**Authorisation.** Roles come only from the bot's view of the member (Get Guild Member as the bot, no privileged intent), never from the browser or the sign-in snapshot; the guild list from sign-in only builds the home page. A page needs the guild to use Rolepay and the bot to see the person in it, with the same 403 for both, so a page reveals neither; that read is cached a minute. An action (`actionAccess`) needs the session's CSRF token, re-reads the member fresh (a role removed in Discord stops the next click), needs the approver role, and hands the services the actor's roles so they check again. A form field claiming roles is ignored.

**Referrer-Policy.** The site sends `no-referrer`, under which a browser sends `Origin: null` on a form post, and the same-origin check refuses it. Dashboard responses send `same-origin` instead (still nothing to other sites). The browser e2e found this; the in-process tests could not.

**Reads.** Only core services (`communities.get`, `keyStatus`, `treasuryBalance`; `payRuns.list`, `get`, `exportCsv`; `payees.list`) and the ports. Chain reads (balance, key) give up after 5 seconds and show "could not read the chain" rather than holding the page. The Runs and Payees pages read at most 1,000 runs and filter, page and total them in memory, which is fine at this scale (a repository query can replace it behind the same page). People are named through the bot (at most 60 lookups a page, cached ten minutes); anyone else shows their Discord ID. Every string a person or Discord controls is escaped, tested with hostile names, notes, policy texts and summaries on every page. Run details show what a run already stores; no Discord message text appears anywhere.

### The policy seam

The Policies and Audit pages, the next scheduled runs on the Overview and the "made by a policy" part of a run read and act through two ports in `dashboard/policyPort.ts`, because core's policy services were built on another branch at the same time:

| Port | Methods |
| --- | --- |
| `PolicyPort` | reads: `list`, `get`, `preview` (who it applies to now with metrics and reasons, near-misses, the next run against the key's budget, why it would be held), `versions`, `upcoming`, `runOrigins`; actions, each with the `actor` (`{ id, roleIds }`, read fresh from Discord): `create` (compile once into a draft), `edit` (recompile into a new version), `approve(version)`, `discard(version)`, `pause`, `resume`, `archive`, `setMode(mode, vetoWindowHours)` |
| `AuditPort` | `eventTypes`, `events({ guildId, type?, actorId?, policyId?, beforeId?, limit })`, newest first |

Expected failures are results with snake_case codes (`not_permitted`, `illegal_state`, `could_not_compile`, ...), shown in words. The port's types are deliberately plain (Dates, bigint micro-units, a JSON-safe filter), so an adapter maps core's entities onto them in a few lines. `InMemoryPolicies` (`@rolepay/web/testing`) implements both ports the way the services are specified (approver role re-checked, compile once into a draft, an edit needs a new approval, every action audited); the web tests and the browser e2e use it.

**Wiring (the main session, after the policies branch merges).** `packages/web` never imports core's policy services. In `apps/server`, write `policyPortFromCore(rolepay)` and `auditPortFromCore(rolepay)` (for example in `src/dashboard.ts`) mapping `PolicyService` and the `AuditEvent` stream onto the two ports, and pass them from `main.ts` as `composeServer({ ..., web: { ..., dashboard: { policies, audit } } })` (`DashboardOverrides`). Nothing else changes; without them the pages say policies are not available on this server.

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
| `/rolepay policy new instruction: schedule: hour: [weekday:] [day:] [timezone:] [name:] [max_per_run:] [max_per_person:]` | approver or proposer role, AI on | deferred, public in the channel (where its runs will post): `policies.create`, then `policies.preview`; the preview has Approve and Discard for that version |
| Approve policy / Discard (on a preview) | approver role (Discard: also the author) | `policies.approve({ version })`, `policies.discard` |
| `/rolepay policy list`, `show policy:` | Manage Server, approver or proposer role | `policies.list`; `policies.detail` and `preview` (deferred, ephemeral) |
| `/rolepay policy pause\|resume\|mode policy: [mode:] [veto_hours:]` | approver role | `policies.pause`, `resume`, `setMode`; answered publicly so the channel sees the change |
| Veto (on an autopilot run) | approver role | `policies.veto`; the message turns into "Vetoed by" |
| `/rolepay policy run_now policy:`, `mode veto_minutes:` | approver role, testnet dev shortcuts only | `scheduler.runNow` (the next period's run, now), then the notifier posts it |
| (the scheduler) | Rolepay | `createPolicyNotifier`: propose-mode runs as the normal review embed (Approve, Cancel) with the policy and period; autopilot runs with "pays at <time> unless vetoed" and Veto; held runs with why and the numbers; one line when nobody matched; the same message is edited when autopilot pays (receipts once) or stops |

Decisions worth knowing:

- **Recipients.** `/rolepay new amount:<per person>` takes `role:` (every registered payee holding it), `users:` (mentions or IDs, `@bob=40` overrides the amount for one person), or both. Only registered payees can hold a line, so role filtering checks each registered payee with Get Guild Member, which needs **no privileged intent**. A List Guild Members implementation (which needs the GUILD_MEMBERS intent) can replace it behind the `MemberDirectory` port if a server ever has more payees than that is comfortable for.
- **Submit at create.** `/rolepay new` creates and submits in one go, so a run shown for review is `pending_approval`. Approve is one transition.
- **Approve answers with UPDATE_MESSAGE.** The review turns into "Approved, paying..." with no buttons inside the 3-second window (so nobody can click twice), the job is queued, and the job edits that same message with the result. A deferred update would leave the buttons live until the job finishes.
- **Subcommand groups.** `/rolepay policy new` arrives as command `rolepay`, sub `policy new`; the router keys handlers on `rolepay policy new`. A policy's messages are posted as the bot with `postMessage`, which returns the message ID, so the executor, the recovery sweep and the policy notifier all edit the same message (`RunNotices`).
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
| Standing policies: schedules and timezones, caps, the PolicyRun state machine (veto timing), the audit CSV; PolicyService and SchedulerService on fakes (two ticks, restart, two instances, veto, over-budget hold, crash at each step, no AI at runtime); two instances on one SQLite file; the handlers, buttons and notifier over a fake Discord with signed interactions; the in-process end to end (`apps/server/test/policies.test.ts`) | `domain/policy/`, `services/policy*`, `services/scheduler*`, `test/policies.sqlite.integration.test.ts`, `packages/discord/src/**/policy*` | `pnpm test` |
| AI, live, opt-in (three real calls: the demo with an injection beside it, the criteria demo, an instruction the filters cannot express) | `packages/core/test/anthropic.live.test.ts` | `ROLEPAY_AI_LIVE=true pnpm test:ai-live` |
| Chain, Moderato testnet, opt-in | `packages/core/test/*.chain.test.ts` (incl. fee budget and one autopilot policy payout after a one-minute veto window), `apps/server/test/server.chain.test.ts` | `pnpm test:chain` |
| Dashboard: sign-in (state, PKCE, CSRF, fixation, logout, expiry, open redirects), authorisation (member read only, approver acts, non-member refused, role revoked mid-session), every page per role, policy actions and the create flow, audit filters and CSV, XSS escaping on every page, the OAuth adapter on a fake fetch | `packages/web/src/dashboard/**/*.test.ts`, `apps/server/test/dashboard.test.ts` | `pnpm test` |
| Browser, Moderato testnet, opt-in | `apps/server/e2e/passkeys.spec.ts` (Playwright, Chromium's virtual WebAuthn authenticator, the real server on `localhost`) | `pnpm test:e2e` |
| Browser, dashboard, opt-in (no network) | `apps/server/e2e/dashboard.spec.ts`: sign in through the fake Discord OAuth, walk Overview, Runs, a run, Policies (in-memory port), a Treasurer action, the Audit log and its CSV, sign out; fails on any CSP violation | `pnpm test:e2e` |

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
- Standing policies: only the latest due period is run (no backlog after downtime, no backfill after a resume); a held run is not retried automatically (the next period runs as usual); a pool is shared among registered matches only; a policy posts in the channel where it was written (no command to move it yet); a policy created from the dashboard without a channel posts nowhere in Discord. A treasurer who approves an autopilot run by hand during its window (from `/rolepay status run:`) races a veto at the same instant; the run's own status is then the truth. Policy names are user text, so the audit stream refers to policies by ID.
- The dashboard reads at most 1,000 runs per page view and keeps its member cache in memory per process; dashboard sessions last eight hours whatever the activity. The member's server list is a snapshot from sign-in (sign out and in to refresh it); access itself is always the bot's live view.
- The WebAuthn endpoints are open (anyone can register a passkey with the server; a registration session never counts as the treasury's passkey, see Setup). POSTs to /webauthn, /claim and /setup are rate limited behind the `RateLimiter` port (`defaultRateLimits` in `apps/server/src/compose.ts`: per client, by the last X-Forwarded-For hop or, behind Fly, by `Fly-Client-IP` (`ROLEPAY_CLIENT_IP_HEADER`), and per endpoint group overall), in memory per process. Expired key-value rows read as absent and are swept on the recovery interval; request bodies have no size cap yet.
