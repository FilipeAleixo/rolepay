<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/rolepay-wordmark-dark.svg">
    <img src="docs/brand/rolepay-wordmark.svg" alt="Rolepay" height="64">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/FilipeAleixo/rolepay/actions/workflows/ci.yml"><img src="https://github.com/FilipeAleixo/rolepay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

Rolepay pays the people who run a Discord community (moderators, staff, bounty winners) in stablecoins on [Tempo](https://tempo.xyz), from Discord. Today that often means one wallet send at a time, a spreadsheet, recipients who need gas, and no clean record. With Rolepay an admin creates a pay run for a role or a list of people, a treasurer approves it with one button, and everyone is paid in one batched transaction, each payout with a memo, exportable to CSV. Recipients sign up with a passkey: no wallet, no seed phrase, no gas. The money stays in the community's own Tempo account. The bot holds only a key that the chain itself limits.

## For judges

### What to look at in 3 minutes

1. **The demo video:** **[TO FILL: VIDEO_URL]**
2. **Get paid on the testnet demo, with nobody online** (about two minutes of your time, paid at the next daily run): join the demo server, **[TO FILL: DISCORD_INVITE_URL. If the demo bot can be added to other servers, its invite link too, for the treasurer side.]** Run `/payee link`, create your passkey and react ✅ to the welcome post in #start-here. A standing policy pays 1 test AlphaUSD to every new payee who did, every day at 18:00 UTC, on autopilot within the bot key's on-chain limit, with a DM receipt. The steps are in [Try it](#try-it).
3. **A pay run on Tempo mainnet,** from the pilot in [`apps/server/MAINNET.md`](apps/server/MAINNET.md): **[TO FILL: MAINNET_TX_URL, the pay run's transaction on explore.tempo.xyz]**
4. **The chain refusing an over-limit batch with Rolepay's own checks skipped:** [the reverted transaction on Moderato](https://explore.testnet.tempo.xyz/tx/0xa29ba08c3162e427cea7008f5fcf902f439eef6c84da27458cc659cf8c0c8ee0), sent by [`protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts).
5. **What can go wrong, and what stops it:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

### What is new here

**The bot never holds the money.** The treasury is the community's own Tempo account, and its root key is the treasurer's passkey, which signs in the browser. The bot holds a Tempo access key with an expiry, a limit per period, and one allowed call: `transferWithMemo` on the payout token. The setup page builds that authorisation from what the treasurer typed and refuses to sign anything else the server sends.
- Code: [`client/keychain.ts`](packages/web/src/client/keychain.ts), [`domain/community.ts`](packages/core/src/domain/community.ts) (`keyAuthorization`, `checkKeyForRun`), [`tempo/tempoPayoutChain.ts`](packages/core/src/adapters/tempo/tempoPayoutChain.ts) (`keyState`)
- Tests: [`client/keychain.test.ts`](packages/web/src/client/keychain.test.ts); [`e2e/passkeys.spec.ts`](apps/server/e2e/passkeys.spec.ts) (real passkeys, the key's scope read back from the chain, replacing the key revokes the old one on chain, a tampered server answer gets nothing signed)

**The limit is the chain's, not only ours.** With Rolepay's pre-flight skipped and nothing simulated, a batch over the key's remaining limit lands and reverts whole with the Account Keychain's `SpendingLimitExceeded`. Each line fits the limit on its own; only the batch does not. Nobody is paid.
- Test: [`test/protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts)

**So are the call scope and the revocation.** Signed by the bot key the same way, a plain `transfer`, a `transferWithMemo` on pathUSD (which the key may spend, but only on fees) and an `approve`, each within the key's limits, land and revert with `CallNotAllowed` ([transfer](https://explore.testnet.tempo.xyz/tx/0x0071e4c1214335babef6078c4b7cbdb8fddb219a6123a6dd771b7675063dfc39), [pathUSD](https://explore.testnet.tempo.xyz/tx/0xbff4a853429837ec91bc11c772acb8686459e8bd8c9f5e7721b80b2898896e0b), [approve](https://explore.testnet.tempo.xyz/tx/0x7ecea9b9108b7e28530dbc0f47d4055bc3e5ea6ec782ee54900704a17f3e640d)), while the in-scope call lands. Once the root has [revoked the key](https://explore.testnet.tempo.xyz/tx/0x453069650656d5aec8e35e7da1b8d53626d412d822d780969d80a815e04c1e1c), a transfer it signs is refused at submit with `KeyAlreadyRevoked`. Nothing moves.
- Test: [`test/protocolKey.chain.test.ts`](packages/core/test/protocolKey.chain.test.ts)

**Every standing policy can have its own on-chain budget.** Access keys are how you give software a budget it can't exceed, so every standing policy can get its own. Off by default: a policy pays from the bot key, like every other run. When an approver approves a policy, Rolepay offers "Give this policy its own budget": on the treasury page the treasurer's passkey authorises a second access key for that policy alone, with its own limit per period, its own expiry and the same one allowed call, signing what the page built from the form (one prompt; a tampered server answer gets nothing signed). From then on that policy's runs are signed with its key and nothing else, so a buggy or compromised policy can spend at most its own key's budget, whatever the bot key has left. Revoking it stops that policy alone; it never falls back to the bot key. `/rolepay policy show` says "Own budget: 20 of 30 AlphaUSD left this period (chain-enforced)", and the policy's dashboard page draws it from the chain.
- Code: [`domain/policy/policyKey.ts`](packages/core/src/domain/policy/policyKey.ts) (`policySigner`), [`services/policyKeyService.ts`](packages/core/src/services/policyKeyService.ts), [`services/payRunService.ts`](packages/core/src/services/payRunService.ts) (`signingKey`), [`routes/policyBudget.ts`](packages/web/src/routes/policyBudget.ts), [`client/policyBudget.ts`](packages/web/src/client/policyBudget.ts)
- Tests: [`test/policyKey.chain.test.ts`](packages/core/test/policyKey.chain.test.ts) on Moderato, one treasury with the bot key (3 a day) and a policy key (1.5 a day): [the policy's run paid with its own key](https://explore.testnet.tempo.xyz/tx/0xc2ec676226c64cf98263082649947c53c9c237970afde04741a8e59d44ea93c3), [a batch over its remaining limit reverted whole with `SpendingLimitExceeded`](https://explore.testnet.tempo.xyz/tx/0x14cd43914bd1c365f937dfeec3f2194a9f99fbcd36b635a7998b3a4451f4a00b) while [the bot key paid a batch of the same shape](https://explore.testnet.tempo.xyz/tx/0x725bcda5895d1fa25b971ffe336096325abe9433ad4e110627953d8d6e87be35), and after [the root revoked the policy key](https://explore.testnet.tempo.xyz/tx/0x20a1223dde0493cd532b6e670b85fc75b3e78f0b95398b52ba3a3937b89d133c) its transfer was refused with `KeyAlreadyRevoked` and [the bot key still paid](https://explore.testnet.tempo.xyz/tx/0x6cc05abcfbd531ff46a0fc31bf208d7843bbc94972fa23052a717803d6981ef7); [`e2e/policyBudget.spec.ts`](apps/server/e2e/policyBudget.spec.ts) (a real passkey, one prompt each to authorise and revoke, a tampered answer signs nothing); [`services/policyKeyExecution.test.ts`](packages/core/src/services/policyKeyExecution.test.ts) (which key signs which run, holds, recovery and retries per key); [`test/policyBudget.test.ts`](apps/server/test/policyBudget.test.ts) (the judge demo with its own budget, through Discord, the treasury page and the dashboard)

**One transaction per run, one memo per line.** The memo carries the run ID and the line number, so "was line 3 of this run paid?" is one log query.
- Code: [`tempo/encoding.ts`](packages/core/src/adapters/tempo/encoding.ts) (`buildBatchCalls`), [`domain/memo.ts`](packages/core/src/domain/memo.ts)
- Test: [`test/rolepay.chain.test.ts`](packages/core/test/rolepay.chain.test.ts) ("creates, approves and executes a 3-line run in ONE sponsored batched tx; reconciles from memo events")

**No gas for recipients, and no fee taken off the payout limit.** On testnet a sponsor pays fees. Without one (mainnet), the bot pays them from a separate pathUSD budget with its own limit, and config refuses a fee token equal to the payout token.
- Code: [`apps/server/src/config.ts`](apps/server/src/config.ts), [`client/fees.ts`](packages/web/src/client/fees.ts)
- Tests: [`test/feeBudget.chain.test.ts`](packages/core/test/feeBudget.chain.test.ts), [`e2e/mainnetPath.spec.ts`](apps/server/e2e/mainnetPath.spec.ts) (the mainnet path, rehearsed on Moderato with no sponsor), [`client/fees.test.ts`](packages/web/src/client/fees.test.ts)

**Never pays twice.** Compare-and-set on the run's version. The signed transaction is stored before it is broadcast. Every attempt has a `validBefore` deadline, and a new one waits until the last can no longer land. The chain head is read before the memo search. One lease per run.
- Code: [`sqlite/repositories.ts`](packages/core/src/adapters/sqlite/repositories.ts), [`services/payRunService.ts`](packages/core/src/services/payRunService.ts), [`kv/runLeases.ts`](packages/core/src/adapters/kv/runLeases.ts)
- Tests: [`services/payRunService.test.ts`](packages/core/src/services/payRunService.test.ts), [`test/rolepay.sqlite.integration.test.ts`](packages/core/test/rolepay.sqlite.integration.test.ts), crash recovery on Moderato in [`test/rolepay.chain.test.ts`](packages/core/test/rolepay.chain.test.ts)

**AI proposes, code checks, a human approves.** Message text is escaped data, user IDs are replaced by tokens before anything is sent, every line is checked in code whatever the model says, and a daily cap bounds the bill.
- Code: [`anthropic/prompts.ts`](packages/core/src/adapters/anthropic/prompts.ts) (escaping), [`proposal/sources.ts`](packages/core/src/domain/proposal/sources.ts) (pseudonymisation), [`adapters/wiring.ts`](packages/core/src/adapters/wiring.ts) (`DailyCappedProposer`)
- Tests: the injection suite in [`proposal/proposal.test.ts`](packages/core/src/domain/proposal/proposal.test.ts)
- Cost: a proposal costs about $0.003 to $0.004 on Sonnet 5.5 with the prompt cache warm (measured live, October 2026). Every model call is stored without any text, the proposer sees what theirs cost, and the dashboard shows the month's AI spend: [`domain/aiUsage.ts`](packages/core/src/domain/aiUsage.ts), [`services/aiUsageService.ts`](packages/core/src/services/aiUsageService.ts)

**Standing policies, with no AI at runtime.** The model compiles the rule once, a human approves it, code runs it, the chain caps it.
- Tests: [`services/schedulerService.test.ts`](packages/core/src/services/schedulerService.test.ts) (no AI at runtime, veto timing, crashes at each step), [`test/policies.sqlite.integration.test.ts`](packages/core/test/policies.sqlite.integration.test.ts) (two instances, one run per period), [`test/policiesDashboard.test.ts`](apps/server/test/policiesDashboard.test.ts), [`test/judgeDemo.test.ts`](apps/server/test/judgeDemo.test.ts) (the judge demo: a daily run pays each new payee once, with nobody online), [`test/policy.chain.test.ts`](packages/core/test/policy.chain.test.ts) (an autopilot payout on Moderato)

**A web dashboard with no script.** Discord sign-in with PKCE (S256) and state, session tokens stored hashed, a CSRF token on every form, and the member's roles read fresh from Discord for every action.
- Code: [`dashboard/sessions.ts`](packages/web/src/dashboard/sessions.ts), [`dashboard/routes/auth.ts`](packages/web/src/dashboard/routes/auth.ts), [`dashboard/access.ts`](packages/web/src/dashboard/access.ts)
- Tests: [`dashboard/auth.test.ts`](packages/web/src/dashboard/auth.test.ts), [`e2e/dashboard.spec.ts`](apps/server/e2e/dashboard.spec.ts)

### How to verify it yourself

```bash
pnpm install
pnpm typecheck
pnpm test            # 1,380 tests in 121 files, no network, no secrets
pnpm test:coverage   # what CI runs, with a threshold per package
```

`pnpm test` runs 1,380 tests: core 699, discord 356, web 197, server 128. They include the SQLite integration tests, the architecture guards and an in-process end to end over signed HTTP.

Coverage from `pnpm test:coverage`:

| Package | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| `packages/core` | 94.97% | 91.68% | 94.91% | 82.65% |
| `packages/discord` | 96.59% | 93.3% | 96.82% | 83.37% |
| `packages/web` | 85.12% | 82.3% | 81.62% | 77.33% |
| `apps/server` | 85.6% | 85.15% | 84.43% | 84.85% |

`packages/web` is lower because its browser code (`src/client/`, 44% of lines here) runs in the Playwright e2e, which these numbers do not count. Its server code is at 99% of lines.

Opt-in suites, on Tempo's Moderato testnet:

- `pnpm test:chain`: full pay runs at service level and over HTTP, the fee budget, an autopilot policy payout after a one-minute veto window, a policy with its own key next to the bot key, and the protocol tests above. It generates throwaway keys into the gitignored `.env`, funds them from the public faucet, and refuses any chain but Moderato. About two minutes.
- `pnpm test:e2e`: Playwright in Chromium with a virtual passkey authenticator. The claim and treasurer flows on Moderato, a policy given its own budget with the passkey on Moderato, the mainnet path rehearsed on Moderato with no sponsor, and the dashboard walk (no network). The first time, install the browser with `pnpm --filter @rolepay/server exec playwright install chromium`.

Where the limit refusal is tested:

| What refuses | Test |
| --- | --- |
| The chain, with Rolepay's checks skipped | [`test/protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts): reverts whole on Moderato, [transaction](https://explore.testnet.tempo.xyz/tx/0xa29ba08c3162e427cea7008f5fcf902f439eef6c84da27458cc659cf8c0c8ee0) |
| The chain, a call outside the key's scope, with Rolepay's checks skipped | [`test/protocolKey.chain.test.ts`](packages/core/test/protocolKey.chain.test.ts): a plain `transfer`, `transferWithMemo` on another token and `approve` each revert with `CallNotAllowed` on Moderato, transactions [1](https://explore.testnet.tempo.xyz/tx/0x0071e4c1214335babef6078c4b7cbdb8fddb219a6123a6dd771b7675063dfc39), [2](https://explore.testnet.tempo.xyz/tx/0xbff4a853429837ec91bc11c772acb8686459e8bd8c9f5e7721b80b2898896e0b), [3](https://explore.testnet.tempo.xyz/tx/0x7ecea9b9108b7e28530dbc0f47d4055bc3e5ea6ec782ee54900704a17f3e640d) |
| The chain, a key the root revoked, with Rolepay's checks skipped | [`test/protocolKey.chain.test.ts`](packages/core/test/protocolKey.chain.test.ts): refused at submit with `KeyAlreadyRevoked`, nothing moves |
| Rolepay's pre-flight, before anything is signed, on Moderato | [`test/rolepay.chain.test.ts`](packages/core/test/rolepay.chain.test.ts) (`insufficient_limit`) |
| The pay-run service, with the numbers | [`services/payRunService.test.ts`](packages/core/src/services/payRunService.test.ts) |
| The fake chain the unit tests use, which enforces the limit as Tempo does | [`memory/fakeChain.ts`](packages/core/src/adapters/memory/fakeChain.ts), [`memory/fakeChain.test.ts`](packages/core/src/adapters/memory/fakeChain.test.ts) |
| A standing policy's run over the key's budget, held whole | [`services/schedulerService.test.ts`](packages/core/src/services/schedulerService.test.ts) |
| The chain, a policy's own key over its own limit while the bot key has plenty, with Rolepay's checks skipped | [`test/policyKey.chain.test.ts`](packages/core/test/policyKey.chain.test.ts): reverts whole on Moderato, [transaction](https://explore.testnet.tempo.xyz/tx/0x14cd43914bd1c365f937dfeec3f2194a9f99fbcd36b635a7998b3a4451f4a00b) |
| A policy's run over its own key's budget, held whole (`over_policy_budget`), the bot key never used for it | [`services/policyKeyExecution.test.ts`](packages/core/src/services/policyKeyExecution.test.ts) |

The threat model, with every threat, its mitigation, the code or test, and what is left: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Try it

A demo runs on Tempo's Moderato testnet at <https://demo.rolepay.app>: test dollars only, nothing real moves. The invite to its Discord server is under [For judges](#for-judges).

About two minutes of your time, as a recipient, with nobody else online:

1. Join the demo Discord server and run `/payee link` in #start-here. Only you see the reply.
2. Open the link and press **Create my passkey**, then confirm with your fingerprint or face. That is your Tempo account: no wallet, no seed phrase, nothing to install, no gas.
3. React ✅ to the welcome post in #start-here.
4. Wait for the next daily run, at 18:00 UTC. A standing policy, "1 AlphaUSD to every registered payee who reacted ✅ to the welcome post and has never been paid", was written once with AI and approved by the treasurer; now code runs it with no AI and nobody online. The run is posted in #payouts with a one-minute veto window, then paid in one batched transaction, capped by the bot key's on-chain limit. You are paid once: after that you no longer match "never paid".
5. You get a DM receipt with your amount and the transaction link, if your privacy settings for the demo server allow direct messages from server members (the payment lands either way). The transaction on Tempo's explorer shows everyone paid in one batch, each line with its memo.

Besides policies, the treasurer can draft a run with AI (`/rolepay propose`, or right-click a message, Apps > Draft pay run with AI) or pay someone directly (right-click their message, Apps > Pay the author, or right-click them, Apps > Pay with Rolepay), and approves each run with one click.

The treasurer side, in your own Discord server: run your own Rolepay with [`apps/server/README.md`](apps/server/README.md) (a Discord application, a tunnel and `pnpm dev`, about 20 minutes). Then `/rolepay setup approver_role:@Treasurer`, create the treasury with a passkey, get testnet funds, authorise the bot key, `/rolepay new`, and Approve.

To pay one person, right-click their message, Apps > **Pay the author** (the run's note links the message), or right-click them, Apps > **Pay with Rolepay**: a form asks for the amount and a note, and the run goes to the Treasurer like any other.

## The trust model

The community's own Tempo account holds the money. The bot never does.

- The treasurer's passkey is the root of the community account.
- The bot holds only a Tempo access key with an expiry, a per-period spending limit, and a scope that allows nothing but memo'd transfers of the payout token.
- The limit is enforced by the protocol, including inside batched transactions. A run that would exceed it is refused whole, and nothing moves. `packages/core/test/protocolLimit.chain.test.ts` shows this on Moderato with Rolepay's own checks skipped.
- The treasurer can revoke the key at any time. Replacing it revokes the old key on chain in the same transaction, and the server destroys the old key's secret.
- A standing policy can have its own access key, with its own limit, authorised by the same passkey. Its runs are signed with that key alone, so that policy can spend at most its own budget; revoking it stops that policy and nothing else.

So a compromised bot can lose at most the key's budget for each period, to scoped transfers, until the key expires or is revoked. A key valid for longer than its period can spend one budget per period until then, so keep the validity short.

What the code adds on top, what the chain guarantees on its own, and what is not mitigated yet is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## AI proposals

AI proposes, the protocol limits, a human approves.

- **From criteria:** `/rolepay propose instruction:"pay 20 to every Mod who answered at least 10 messages in #help this month"`. The model (Claude Sonnet 5.5) turns the instruction into a filter; Rolepay's code runs it over the registered payees. The member list never goes to the model.
- **From messages:** read a whole channel or thread with `/rolepay propose source:#bounties instruction:"pay everyone who closed a bounty, 50 each"`, or one message: right-click the winners announcement, Apps > **Draft pay run with AI**, and type "50 each, the indexer one 200". The form says what happens: Rolepay reads the message and drafts lines for the people it names; nothing is paid until the Treasurer approves.
- The answer is a proposal, not a run: one line per person with the amount and why (with a link to the message, or "34 replies"), what was left out and why, who is not registered yet, and the total against the bot key's remaining budget. Create pay run turns it into a normal run that still needs the treasurer's approval; Edit changes the lines; Discard drops it.
- Code checks every line, whatever the model says: a line backed only by the recipient's own message ("pay me 10,000"), a line whose amount the instruction does not state, or one larger than the key's budget is held and shown, never paid. Bots are never paid. When everyone is held for writing their own message ("2 each to everyone who wrote here today"), the proposal says that is a rule about activity and offers **Count who wrote** (criteria mode). Even a run forced through stays under the bot key's on-chain limit.
- Off until a treasurer turns it on (`/rolepay setup ai_proposals:true`). Only the approver role, or an optional proposer role, can propose. Proposing from messages sends their text to Anthropic's API with user IDs replaced by tokens; logs keep counts and cost, never text.

## Standing policies

AI writes the rule once. Humans approve it. Code runs it. The chain caps it.

- **Write it once.** A treasurer types a rule such as "every Monday: 1 per answered question in #help, max 50 a week each, for Mods" with `/rolepay policy new`. The model compiles it once into a filter and an amount rule.
- **See who it applies to before approving.** Rolepay shows who it matches right now, with each person's count, why they match and the amount. Only the approver role activates it, and any edit needs a new approval.
- **No AI at runtime.** On schedule, code alone runs the rule over the week since the last run. On the testnet demo a policy can also run daily (a demo control, impossible on mainnet): that is how judges get paid with nobody online. In propose mode each run waits for the usual one-tap approval. On autopilot it is posted with "pays at 18:00 unless vetoed" and a Veto button, then pays within the bot key's on-chain limit, and its message then reads "Paid on autopilot after the veto window; no veto. Policy approved by @Treasurer (version 1)", never "Approved by" someone who did not approve that run.
- **Held whole, never paid in part.** A run over the key's budget or the policy's cap is held and explained. Every step goes to an audit log, and one run per period holds across restarts and a second server on the same database.
- **Its own budget, if you want one.** After approving, the treasurer can give the policy its own access key on the treasury page (one passkey prompt). Its runs are then signed with that key alone and capped by its limit on chain; the bot key keeps paying everything else.

## Repository

- `packages/core`: the domain (run state machine, money, memos, proposals), ports, adapters (Tempo, SQLite, key vault, Anthropic, in-memory fakes) and services, which are the only public interface.
- `packages/discord`: the Discord adapter over HTTP interactions.
- `packages/web`: the home page, the claim, treasurer setup and payee account pages (passkeys), and the web dashboard, in one dark design with the fonts served from the same origin.
- `apps/server`: the composition root (Hono).
- `docs/ARCHITECTURE.md`: the design. `docs/THREAT-MODEL.md`: the threat model.

See `docs/ARCHITECTURE.md` for the design and `apps/server/README.md` to run it (and, under "Deploying", how the hosted servers run on Fly.io). The testnet demo runs at `demo.rolepay.app`; mainnet is prepared for `app.rolepay.app` (USDC.e payouts, runbook in `apps/server/MAINNET.md`).

Rolepay was called payrun while it was built. Settings, data and Discord messages from then keep working: see "Renamed from payrun" in `docs/ARCHITECTURE.md`.

## How this was built

I designed the product, the architecture and the trust model, and directed AI coding agents (Claude Code) to implement it under test-driven development. I reviewed and tested every step, on Tempo's testnet. Commits carry a `Co-Authored-By: Claude` line for that reason.

Built for Colosseum's Crypto World's Fair, October 2026.

## License

MIT
