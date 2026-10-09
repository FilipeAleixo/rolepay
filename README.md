<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/rolepay-wordmark-dark.svg">
    <img src="docs/brand/rolepay-wordmark.svg" alt="Rolepay" height="64">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/FilipeAleixo/rolepay/actions/workflows/ci.yml"><img src="https://github.com/FilipeAleixo/rolepay/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
</p>

<p align="center"><em>Built for Colosseum's <a href="https://colosseum.com/worldsfair">Crypto World's Fair</a> hackathon, Tempo track.</em></p>

Rolepay pays the people who run a Discord community (moderators, staff, bounty winners) in stablecoins on [Tempo](https://tempo.xyz), from Discord. Today that usually means working out who did what by hand in a spreadsheet, then a multisig batch outside Discord once enough signers are online, and recipients who need a wallet and gas. With Rolepay, the list comes from Discord itself (a role, a few names, or plain words to the AI), a treasurer approves the run with one button, and one transaction pays everyone, with a memo on every line and a CSV for every run. Recipients sign up with a passkey (no wallet, no seed phrase, and no gas token to buy: fees on Tempo are paid in the stablecoin itself) or with a wallet they already have on Tempo. The money stays in the community's own Tempo account. The bot holds only a key that the chain itself limits.

![A real pay run on Tempo mainnet: started in Discord, approved in the treasury channel, the payee's balance updating live, the receipt by DM, and the transaction on the explorer](docs/img/rolepay-demo.gif)

## For judges

Rolepay runs in two places. The testnet demo at [demo.rolepay.app](https://demo.rolepay.app) runs on Tempo's Moderato testnet with test dollars, and has every feature turned on: AI proposals, standing policies, preferred stablecoins, deposit addresses and the judge flow below. The mainnet pilot at [web.rolepay.app](https://web.rolepay.app) pays real USDC.e in a small pilot community, with AI proposals and preferred stablecoins off.

### What to look at in 3 minutes

1. **The videos:** [the pitch](https://youtu.be/eYC79TOwGdY) (2:48) and [the product demo](https://youtu.be/VvBoJemKTLU) (2:24).
2. **Get paid on the testnet demo, with nobody online.** Join the demo server at [discord.gg/tCuABJt72P](https://discord.gg/tCuABJt72P), run `/payee link` in #start-here, create your passkey from the link, and react ✅ to the welcome post. Every day at 16:00 UTC a standing policy pays 1 test AlphaUSD to each new payee who did, on autopilot and within its key's on-chain limit, with a DM receipt. It takes about two minutes of your time. The steps are in [Try it](#try-it).
3. **A pay run on Tempo mainnet.** [The first one](https://explore.tempo.xyz/tx/0x3cde4de2241315c563ed2316ba859ed763b2a669fcec8811620da25a95761593), on 8 October 2026, paid 1 USDC.e from the pilot community's treasury to a member's passkey account. A treasurer approved it in Discord, the bot's access key signed it as one `transferWithMemo`, and the fee, 0.00005 pathUSD, came out of the key's separate fee budget. The pilot's runbook is [`apps/server/MAINNET.md`](apps/server/MAINNET.md).
4. **The chain refusing an over-limit batch, with Rolepay's own checks skipped.** [The reverted transaction on Moderato](https://explore.testnet.tempo.xyz/tx/0xa29ba08c3162e427cea7008f5fcf902f439eef6c84da27458cc659cf8c0c8ee0), sent by [`protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts). Each line fits the key's limit on its own. The batch does not, so it reverts whole and nobody is paid.
5. **What can go wrong, and what stops it:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

### What is new here

A Safe keeps a community's money safe, but it does not know who did the work. Today a person reads Discord into a spreadsheet, and that list is the hard part, not the transfer. Rolepay works out who gets paid from what happened in Discord, and pays them all with one approval, to people who need nothing but a passkey.

- The list comes from Discord itself: a role, a few names, or plain words to the AI (who reacted to a post, who answered in #help, who closed a bounty). The run is approved with one button in Discord, where the work happened.
- The people paid need only a passkey. It is the whole account: no wallet, no seed phrase, no gas token. Each person is paid in the stablecoin they prefer (swapped in the same transaction), gets a receipt in Discord, and has a page to see their money and send it on. Paid from a Safe on an EVM chain, every recipient needs a wallet, and the chain's gas coin to move what they were paid.
- The guardrails of a multisig, for a community too small for one: the treasurer's passkey and a bot with a capped key, and no signers to gather for each run. Regular pay runs on its own, with a veto window.

Spending limits and batch payouts exist on other chains as Safe modules and tools (Safe's spending-limit module, CSV Airdrop, Disperse). On Tempo they are part of the account and compose in one transaction. The bot's spending key belongs to the treasury account itself, scoped to the calls it needs, with an expiry, and a standing policy can have one of its own; there is no module to install and audit. A run's memos, its fee (sponsored, or paid in a stablecoin) and any swaps on the enshrined stablecoin DEX go into the same transaction, and a deposit address per funder credits the treasury with no sweep. It costs under a cent per payout: the first mainnet payout's fee was 0.00005 pathUSD, and the pilot's runbook ([`apps/server/MAINNET.md`](apps/server/MAINNET.md)) estimates about $0.001 per transfer to an existing account and about $0.006 to a new one.

The items down to funding with attribution are built on those Tempo features: access keys whose limits the chain enforces, passkey accounts, transfer memos, the enshrined stablecoin DEX, fee sponsorship and fee tokens, and virtual addresses. The rest is the product around them. Each item links its code, its tests and, for the chain tests, the transactions they sent on Moderato.

**The bot never holds the money.** The treasury is the community's own Tempo account, and its root key is the treasurer's passkey, which signs in the browser. The bot holds a Tempo access key with an expiry, a limit per period and one allowed call: `transferWithMemo` on the payout token. The setup page builds that authorisation from what the treasurer typed and refuses to sign anything else the server sends.
- Code: [`client/keychain.ts`](packages/web/src/client/keychain.ts), [`domain/community.ts`](packages/core/src/domain/community.ts) (`keyAuthorization`, `checkKeyForRun`), [`tempo/tempoPayoutChain.ts`](packages/core/src/adapters/tempo/tempoPayoutChain.ts) (`keyState`)
- Tests: [`client/keychain.test.ts`](packages/web/src/client/keychain.test.ts); [`e2e/passkeys.spec.ts`](apps/server/e2e/passkeys.spec.ts) (real passkeys, the key's scope read back from the chain, replacing the key revokes the old one on chain, a tampered server answer gets nothing signed)

**The limit is the chain's, not only ours.** With Rolepay's pre-flight skipped and nothing simulated, a batch over the key's remaining limit lands and reverts whole with the Account Keychain's `SpendingLimitExceeded`. Each line fits the limit on its own; the batch does not. Nobody is paid.
- Test: [`test/protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts)

**So are the call scope and the revocation.** Signed by the bot key the same way, a plain `transfer`, a `transferWithMemo` on pathUSD (which the key may spend, but only on fees) and an `approve`, each within the key's limits, land and revert with `CallNotAllowed` ([transfer](https://explore.testnet.tempo.xyz/tx/0x0071e4c1214335babef6078c4b7cbdb8fddb219a6123a6dd771b7675063dfc39), [pathUSD](https://explore.testnet.tempo.xyz/tx/0xbff4a853429837ec91bc11c772acb8686459e8bd8c9f5e7721b80b2898896e0b), [approve](https://explore.testnet.tempo.xyz/tx/0x7ecea9b9108b7e28530dbc0f47d4055bc3e5ea6ec782ee54900704a17f3e640d)), while the in-scope call lands. Once the root has [revoked the key](https://explore.testnet.tempo.xyz/tx/0x453069650656d5aec8e35e7da1b8d53626d412d822d780969d80a815e04c1e1c), a transfer it signs is refused at submit with `KeyAlreadyRevoked`. Nothing moves.
- Test: [`test/protocolKey.chain.test.ts`](packages/core/test/protocolKey.chain.test.ts)

**Each standing policy can have its own on-chain budget.** Access keys are how you give software a budget it can't exceed, so a policy can get a key of its own. Off by default, a policy pays from the bot key like any other run. When a policy is approved, Rolepay offers "Give this policy its own budget". On the treasury page, the treasurer's passkey authorises a second access key for that policy alone, with its own limit per period, its own expiry and the same one allowed call. It is one prompt, and the page signs only what it built from the form. From then on the policy's runs are signed with its key and nothing else, so a rule that goes wrong can spend at most its own budget, whatever the bot key has left. Revoking the key stops that policy alone; it never falls back to the bot key. `/rolepay policy show` says "Own budget: 20 of 30 AlphaUSD left this period (chain-enforced)", and the policy's dashboard page draws it from the chain.
- Code: [`domain/policy/policyKey.ts`](packages/core/src/domain/policy/policyKey.ts) (`policySigner`), [`services/policyKeyService.ts`](packages/core/src/services/policyKeyService.ts), [`services/payRunService.ts`](packages/core/src/services/payRunService.ts) (`signingKey`), [`routes/policyBudget.ts`](packages/web/src/routes/policyBudget.ts), [`client/policyBudget.ts`](packages/web/src/client/policyBudget.ts)
- Tests: [`test/policyKey.chain.test.ts`](packages/core/test/policyKey.chain.test.ts) on Moderato, one treasury with the bot key (3 a day) and a policy key (1.5 a day): [the policy's run paid with its own key](https://explore.testnet.tempo.xyz/tx/0xc2ec676226c64cf98263082649947c53c9c237970afde04741a8e59d44ea93c3), [a batch over its remaining limit reverted whole with `SpendingLimitExceeded`](https://explore.testnet.tempo.xyz/tx/0x14cd43914bd1c365f937dfeec3f2194a9f99fbcd36b635a7998b3a4451f4a00b) while [the bot key paid a batch of the same shape](https://explore.testnet.tempo.xyz/tx/0x725bcda5895d1fa25b971ffe336096325abe9433ad4e110627953d8d6e87be35), and after [the root revoked the policy key](https://explore.testnet.tempo.xyz/tx/0x20a1223dde0493cd532b6e670b85fc75b3e78f0b95398b52ba3a3937b89d133c) its transfer was refused with `KeyAlreadyRevoked` and [the bot key still paid](https://explore.testnet.tempo.xyz/tx/0x6cc05abcfbd531ff46a0fc31bf208d7843bbc94972fa23052a717803d6981ef7); [`e2e/policyBudget.spec.ts`](apps/server/e2e/policyBudget.spec.ts) (a real passkey, one prompt each to authorise and revoke, a tampered answer signs nothing); [`services/policyKeyExecution.test.ts`](packages/core/src/services/policyKeyExecution.test.ts) (which key signs which run, holds, recovery and retries per key); [`test/policyBudget.test.ts`](apps/server/test/policyBudget.test.ts) (the judge demo with its own budget, through Discord, the treasury page and the dashboard)

**One transaction per run, one memo per line.** The memo carries the run ID and the line number, so "was line 3 of this run paid?" is one log query.
- Code: [`tempo/encoding.ts`](packages/core/src/adapters/tempo/encoding.ts) (`buildBatchCalls`), [`domain/memo.ts`](packages/core/src/domain/memo.ts)
- Test: [`test/rolepay.chain.test.ts`](packages/core/test/rolepay.chain.test.ts) ("creates, approves and executes a 3-line run in ONE sponsored batched tx; reconciles from memo events")

**Each person paid in the stablecoin they prefer, still in one transaction.** A payee picks, say, BetaUSD with `/payee prefer` or on their account page, which then lists that coin marked "preferred", even at 0. The run buys it on Tempo's enshrined stablecoin DEX with an exact-output swap capped at 1% over the amount, then delivers it with the same `transferWithMemo` and memo as any other line, all in the one batch. A quote over the cap, or no route, holds the run before anything is signed. A price that moves past the cap before the block reverts the whole batch, and nobody is paid. The treasurer turns this on with the passkey by signing a new key. That key (and a policy's own key, under that policy's limit) gains exactly the exact-output swap and `transferWithMemo` on the preferred tokens, each under its own limit. Tempo charges a swap's input to the key's limit in the token it sells, so the payout limit still caps everything that leaves the treasury in the payout token.
- Code: [`tempo/encoding.ts`](packages/core/src/adapters/tempo/encoding.ts) (`buildBatchCalls`), [`domain/delivery.ts`](packages/core/src/domain/delivery.ts), [`domain/community.ts`](packages/core/src/domain/community.ts) (`preferredTokenGrants`), [`services/payRunService.ts`](packages/core/src/services/payRunService.ts) (`swapPreflight`)
- Tests: [`test/preferredToken.chain.test.ts`](packages/core/test/preferredToken.chain.test.ts) on Moderato: [AlphaUSD and BetaUSD paid in one batch](https://explore.testnet.tempo.xyz/tx/0xc2ea8362a093de1121b271070ff912b8761f4acbf08488f2e92e757875e66859), [a swap over its maximum reverting whole](https://explore.testnet.tempo.xyz/tx/0x777637b500b0618cec62af62f75efa90120d68e7d192f60ee493703deba5f37c) (`MaxInputExceeded`), and the key refused outside a run ([`swapExactAmountIn`](https://explore.testnet.tempo.xyz/tx/0xc94b6d0d07e279aadf42ff0ecfea0612da3ebd2b7d262ecdd1fa5ca498f044a3), [selling a token it has no limit for](https://explore.testnet.tempo.xyz/tx/0x8e1e61015c82ea62ea2b9126d1116fc9906cbbf7a34b51f8b96f3a3d236d8190)); [`e2e/passkeys.spec.ts`](apps/server/e2e/passkeys.spec.ts) (the swap scope signed with a real passkey and read back from the chain); [`services/preferredTokens.test.ts`](packages/core/src/services/preferredTokens.test.ts); [`services/policyKeyExecution.test.ts`](packages/core/src/services/policyKeyExecution.test.ts) (a policy's own key paying a swapped line from its own limits, and one authorised before the switch held, never the bot key)

**Being paid costs recipients nothing, and no fee comes off the payout limit.** On testnet a sponsor pays the fees. Without one, as on mainnet, the bot pays them from a separate pathUSD budget on its key, with its own limit, and config refuses a fee token equal to the payout token. When a recipient later sends money on from their account page, the network fee (about a cent) is paid in the stablecoin they send; there is no separate gas token to hold.
- Code: [`apps/server/src/config.ts`](apps/server/src/config.ts), [`client/fees.ts`](packages/web/src/client/fees.ts)
- Tests: [`test/feeBudget.chain.test.ts`](packages/core/test/feeBudget.chain.test.ts), [`e2e/mainnetPath.spec.ts`](apps/server/e2e/mainnetPath.spec.ts) (the mainnet path, rehearsed on Moderato with no sponsor), [`client/fees.test.ts`](packages/web/src/client/fees.test.ts)

**Funding with attribution, on Tempo's virtual addresses (TIP-1022).** The treasury registers once as a virtual-address master. The setup page mines the registration's 32-bit proof of work in the browser, builds the call itself, refuses a server copy that differs, and the passkey signs one transaction. Each funding source ("Q4 bounty sponsor: Acme DAO", "Judges pool") then gets its own deposit address, derived off chain. Whatever is sent there lands in the treasury in the same transaction, with no sweep, and Rolepay attributes it to its source from the two Transfer events the protocol emits. A deposit address can only ever add money. Sources are made with `/rolepay fund new`; the dashboard's Funding page shows each address with a QR code and every deposit, and the Overview shows what came in this month.
- Code: [`domain/funding.ts`](packages/core/src/domain/funding.ts) (`attributeDeposits`), [`services/fundingService.ts`](packages/core/src/services/fundingService.ts), [`tempo/tempoFundingChain.ts`](packages/core/src/adapters/tempo/tempoFundingChain.ts), [`client/deposits.ts`](packages/web/src/client/deposits.ts)
- Tests: [`test/funding.chain.test.ts`](packages/core/test/funding.chain.test.ts) (on Moderato: a passkey-like treasury registers, two deposits land with no sweep, each attributed once), [`services/fundingService.test.ts`](packages/core/src/services/fundingService.test.ts) (idempotent, two instances), [`e2e/depositAddresses.spec.ts`](apps/server/e2e/depositAddresses.spec.ts) (the browser mines, a tampered plan gets nothing signed, one passkey prompt)
- On Moderato: [the registration](https://explore.testnet.tempo.xyz/tx/0x2c263e0461d1facdec17c88ab5c4e3bc5bcc956c541c4b1e15f9b7fe9708abb5), deposits to [source 1](https://explore.testnet.tempo.xyz/tx/0x2a7f8c310c397b0d6b81a847eccbe4251274284aa614bc54e62549ade0b1aefa) and [source 2](https://explore.testnet.tempo.xyz/tx/0x266eb6fbc465a110f1c8cc59913495e0aa1740af3aacb1e75d81fe7076c880f9), each showing the two hops into the treasury; and from the treasury page in Chromium, [registered by the passkey](https://explore.testnet.tempo.xyz/tx/0xb34f5265d5f6caed1150d8db6383b022acbe47e93bf5d1792a564b3ff50132e7) and [a deposit](https://explore.testnet.tempo.xyz/tx/0xfecebc1c81b94be320af2234579341d45b8f30b0c2308972b4039f47b3d99048)

**Bring your own Tempo address, proven by a signature.** A recipient who already has a wallet on Tempo can be paid there instead of creating a passkey. On the claim page, "Use a wallet I already have" asks the wallet in the page (`window.ethereum`, for example MetaMask) to switch to Tempo and sign one plain-English message. It names the site, the chain, the community, the person, the address and a single-use nonce bound to the claim link. The server registers the address it recovers from the signature, never one the page sends, and refuses a replayed, edited or expired message. Runs, policies and preferred stablecoins pay that address unchanged. Its receipts link it on the explorer, since there is no Rolepay account page for it, and both the claim page and the receipts say Rolepay cannot move or recover money there. There is no new script origin: the CSP is the same.
- Code: [`domain/walletClaim.ts`](packages/core/src/domain/walletClaim.ts), [`services/payeeService.ts`](packages/core/src/services/payeeService.ts) (`walletChallenge`, `registerExternal`), [`client/wallet.ts`](packages/web/src/client/wallet.ts)
- Tests: [`services/payeeService.test.ts`](packages/core/src/services/payeeService.test.ts) (every refusal, the nonce taken once, the audited switch between a passkey and a wallet), [`routes/claimWallet.test.ts`](packages/web/src/routes/claimWallet.test.ts) (a viem account signs; tampering with any field fails), [`client/wallet.test.ts`](packages/web/src/client/wallet.test.ts) (a fake EIP-1193 wallet), [`e2e/ownWallet.spec.ts`](apps/server/e2e/ownWallet.spec.ts) (a real browser at 375 px, through to a paid run), [`test/externalAddress.chain.test.ts`](packages/core/test/externalAddress.chain.test.ts): [an own wallet paid by a run on Moderato](https://explore.testnet.tempo.xyz/tx/0x8a1248fa0eba6ce0427ceb9c9a65909bd4b14f6110374d398867e35bade298c9)

**Never pays twice.** A run changes state only by compare-and-set on its version. The signed transaction is stored before it is broadcast. Every attempt has a `validBefore` deadline, and a new one waits until the last can no longer land. The chain head is read before the memo search. One lease per run.
- Code: [`sqlite/repositories.ts`](packages/core/src/adapters/sqlite/repositories.ts), [`services/payRunService.ts`](packages/core/src/services/payRunService.ts), [`kv/runLeases.ts`](packages/core/src/adapters/kv/runLeases.ts)
- Tests: [`services/payRunService.test.ts`](packages/core/src/services/payRunService.test.ts), [`test/rolepay.sqlite.integration.test.ts`](packages/core/test/rolepay.sqlite.integration.test.ts), crash recovery on Moderato in [`test/rolepay.chain.test.ts`](packages/core/test/rolepay.chain.test.ts)

**AI proposes, code checks, a person approves.** Message text is escaped data, user IDs are replaced by tokens before anything is sent, every line is checked in code whatever the model says, and a daily cap bounds the bill.
- Code: [`anthropic/prompts.ts`](packages/core/src/adapters/anthropic/prompts.ts) (escaping), [`proposal/sources.ts`](packages/core/src/domain/proposal/sources.ts) (pseudonymisation), [`adapters/wiring.ts`](packages/core/src/adapters/wiring.ts) (`DailyCappedProposer`)
- Tests: the injection suite in [`proposal/proposal.test.ts`](packages/core/src/domain/proposal/proposal.test.ts)
- Cost: a proposal costs about $0.003 to $0.004 on Sonnet 5.5 with the prompt cache warm (measured live, October 2026). Every model call is stored without any text, the proposer sees what theirs cost, and the dashboard shows the month's AI spend: [`domain/aiUsage.ts`](packages/core/src/domain/aiUsage.ts), [`services/aiUsageService.ts`](packages/core/src/services/aiUsageService.ts)

**Standing policies, with no AI at runtime.** The model compiles the rule once, a person approves it, code runs it, the chain caps it.
- Tests: [`services/schedulerService.test.ts`](packages/core/src/services/schedulerService.test.ts) (no AI at runtime, veto timing, crashes at each step), [`test/policies.sqlite.integration.test.ts`](packages/core/test/policies.sqlite.integration.test.ts) (two instances, one run per period), [`test/policiesDashboard.test.ts`](apps/server/test/policiesDashboard.test.ts), [`test/judgeDemo.test.ts`](apps/server/test/judgeDemo.test.ts) (the judge demo: a daily run pays each new payee once, with nobody online), [`test/policy.chain.test.ts`](packages/core/test/policy.chain.test.ts) (an autopilot payout on Moderato)

**A web dashboard that works without JavaScript, and updates live with it.** Sign-in is with Discord, using PKCE (S256) and state. Session tokens are stored hashed, every form carries a CSRF token, and the member's roles are read fresh from Discord for every action. Over server-sent events, a run's page turns to Paid with its transaction as it lands, the Overview's panels refresh, and a payee's account page counts the balance up and slides the payment in. Each stream is scoped exactly like the page it serves.
- Code: [`dashboard/sessions.ts`](packages/web/src/dashboard/sessions.ts), [`dashboard/routes/auth.ts`](packages/web/src/dashboard/routes/auth.ts), [`dashboard/access.ts`](packages/web/src/dashboard/access.ts), [`services/liveService.ts`](packages/core/src/services/liveService.ts), [`live/streams.ts`](packages/web/src/live/streams.ts), [`client/dashboardLive.ts`](packages/web/src/client/dashboardLive.ts)
- Tests: [`dashboard/auth.test.ts`](packages/web/src/dashboard/auth.test.ts), [`dashboard/live.test.ts`](packages/web/src/dashboard/live.test.ts), [`routes/accountLive.test.ts`](packages/web/src/routes/accountLive.test.ts), [`test/live.test.ts`](apps/server/test/live.test.ts), [`e2e/dashboard.spec.ts`](apps/server/e2e/dashboard.spec.ts)

### How to verify it yourself

You need Node 22 or later and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test            # 1,998 tests in 163 files, no network, no secrets
pnpm test:coverage   # what CI runs, with a threshold per package
```

`pnpm test` runs 1,998 tests: core 965, discord 463, web 400, server 170. They include the SQLite integration tests, the architecture guards and an in-process end to end over signed HTTP.

Coverage from `pnpm test:coverage`:

| Package | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| `packages/core` | 95.94% | 92.84% | 95.73% | 84.71% |
| `packages/discord` | 96.97% | 93.68% | 97.07% | 84.17% |
| `packages/web` | 88.84% | 85.71% | 85.11% | 77.91% |
| `apps/server` | 86.83% | 86.37% | 86.27% | 85.22% |

`packages/web` is lower because its browser code (`src/client/`, 35% of lines here, 71% of them covered by unit tests on fake DOMs and wallets) runs in the Playwright e2e, which these numbers do not count. Its server code is at 98.6% of lines.

Two opt-in suites run on Tempo's Moderato testnet:

- `pnpm test:chain` (39 tests in 10 files): full pay runs at service level and over HTTP, the fee budget, an autopilot policy payout after a one-minute veto window, a policy with its own key next to the bot key, preferred stablecoins bought on the DEX in the same batch, deposit addresses (a passkey-like treasury registers, two deposits land with no sweep and are attributed), a recipient's own wallet (an EOA registered by its signature, then paid by a run), and the protocol tests above. It generates throwaway keys into the gitignored `.env`, funds them from the public faucet, and refuses any chain but Moderato. It takes three to four minutes.
- `pnpm test:e2e`: Playwright in Chromium with a virtual passkey authenticator. On Moderato: the claim and treasurer flows (among them the preferred stablecoin switch and a BetaUSD payout from a passkey treasury), a policy given its own budget with the passkey, deposit addresses set up on the treasury page (the salt mined in the browser), a recipient registering their own wallet at phone width with an injected test wallet and then being paid, and the mainnet path rehearsed with no sponsor. With no network: the dashboard walk. The first time, install the browser with `pnpm --filter @rolepay/server exec playwright install chromium`.

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
| A policy's run within the key's budget but over it once its swaps into preferred stablecoins count at their maximum, held whole when it is made (`swaps_over_budget`, `swaps_over_policy_budget`) | [`services/schedulerService.test.ts`](packages/core/src/services/schedulerService.test.ts), [`services/policyKeyExecution.test.ts`](packages/core/src/services/policyKeyExecution.test.ts) |

The threat model, with every threat, its mitigation, the code or test, and what is left: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Try it

The demo runs on Tempo's Moderato testnet at <https://demo.rolepay.app>. It uses test dollars only; nothing real moves.

### As a recipient, with nobody else online

It takes about two minutes of your time.

1. Join the [demo Discord server](https://discord.gg/tCuABJt72P) and run `/payee link` in #start-here. Only you see the reply.
2. Open the link, press **Create my passkey (no wallet needed)**, and confirm with your fingerprint or face. That is your Tempo account: no wallet, no seed phrase, nothing to install, and no gas token. Being paid is free; sending it on later costs about a cent on mainnet, paid in the stablecoin you send (on the demo a sponsor pays). If you already have a wallet on Tempo, such as MetaMask, press **Use a wallet I already have** instead and sign the message it shows. Signing costs nothing and moves no money, and you are paid at that address.
3. React ✅ to the welcome post in #start-here.
4. Wait for the next daily run, at 16:00 UTC. A standing policy pays 1 AlphaUSD to every registered payee who reacted ✅ to the welcome post and has never been paid. It was written once with AI and approved by a treasurer; code runs it now, with no AI and nobody online. The run is posted in #payouts, waits out a one-minute veto window, then pays everyone in one batched transaction, capped by its key's on-chain limit. The Veto button is in the treasurers' private channel, so #payouts shows the run with no button you cannot use. You are paid once: after that you no longer match "never paid".
5. You get a DM receipt with your amount and the transaction link, if your privacy settings for the demo server allow direct messages from server members. The payment lands either way. On Tempo's explorer the transaction shows everyone paid in one batch, each line with its memo.

If you used a passkey, open your account page from **Your account** in the receipt, or from **Payee account** on the [demo's home page](https://demo.rolepay.app), and sign in with the same passkey. It shows your balance and each payment as it arrives, lets you choose the stablecoin you would rather be paid in, and lets you send money on.

### As a treasurer

Add the demo bot to a Discord server you own with **Add to your server** on the [demo's home page](https://demo.rolepay.app) (it runs on testnet), or run your own Rolepay with [`apps/server/README.md`](apps/server/README.md): a Discord application, a tunnel and `pnpm dev`, about 20 minutes. Then:

1. Create a role for the people who approve, for example `Treasurer`, and give it to yourself. Then create a private text channel named `treasury` for that role and Rolepay's role, with View Channel, Send Messages and Embed Links. Rolepay finds it by its name and posts there everything only a treasurer can act on, with its buttons: runs and policies to approve, runs to veto, runs it holds. The channel each would have gone to gets the same message without the buttons. A treasurer can choose another channel, or none, on the dashboard's Overview. Every button still checks the role, whoever presses it.
2. Run `/rolepay setup approver_role:@Treasurer` and open the treasury page link it gives you (only you see it, for 30 minutes). Press **Create the treasury passkey**, then **Get testnet funds**.
3. Press **Authorise the bot key with my passkey**: a limit per period, an expiry and one allowed call, signed with one prompt.
4. Ask people to run `/payee link`, and run it yourself. Then start a run, for example `/rolepay new amount:1 role:@Mods` or `/rolepay new amount:1 users:@alice @bob`, and press **Approve and pay** in #treasury. Everyone is paid in one transaction, and each person gets a DM receipt.

To pay one person, right-click their message and choose Apps > Pay the author (the run's note links the message), or right-click them and choose Apps > Pay with Rolepay. A form asks for the amount and a note, and the run goes to the treasurers like any other. To draft a run with AI, turn it on with `/rolepay setup ai_proposals:true`, then use `/rolepay propose`, or right-click a message and choose Apps > Draft pay run with AI. The record is on the web: Treasury dashboard on the home page, signed in with Discord.

The mainnet app at web.rolepay.app is a private pilot. Its bot cannot be added to other servers yet.

## The trust model

The community's own Tempo account holds the money. The bot never does.

- The treasurer's passkey is the root key of that account. It signs in the browser, and the server never holds it.
- The bot holds only a Tempo access key with an expiry, a spending limit per period, and one allowed call: `transferWithMemo` on the payout token. When a community pays people in their preferred stablecoin, the key also gets the stablecoin DEX's exact-output swap and `transferWithMemo` on those tokens, each under its own limit.
- The protocol enforces the limit, inside batched transactions too. A run that would exceed it is refused whole, and nothing moves. [`protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts) shows this on Moderato with Rolepay's own checks skipped.
- The treasurer can revoke the key at any time. Replacing it revokes the old key on chain in the same transaction, and the server destroys the old key's secret.
- A standing policy can have its own access key, with its own limit, authorised by the same passkey. Its runs are signed with that key alone, and revoking it stops that policy and nothing else.

So a fully compromised server can spend at most each key's limit per period, through those scoped calls, until the keys expire or are revoked. A key valid for longer than its period can spend one budget per period until then, so keep the validity short. The exact bound, with fee budgets and preferred stablecoins, is in the threat model (T1, T24, T26).

Everything else (who may approve, never paying twice, the checks on AI proposals) is Rolepay's code, and holds only while the server is honest. The largest accepted risk: the setup page's code is served by the same server that holds the bot key, so a fully compromised server could serve a page that asks the treasurer's passkey to sign something else (T15). [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) has every threat, its mitigation, the code or test, and what is left.

## AI proposals

AI proposes, the protocol limits, a person approves. AI proposals are off until a treasurer turns them on with `/rolepay setup ai_proposals:true`, and only the approver role, or an optional proposer role, can propose.

There are two ways to ask. From criteria: `/rolepay propose instruction:"pay 20 to every Mod who answered at least 10 messages in #help this month"`. The model (Claude Sonnet 5.5) turns the instruction into a filter, and Rolepay's code runs it over the registered payees. The member list never goes to the model. From messages: `/rolepay propose source:#bounties instruction:"pay everyone who closed a bounty, 50 each"` reads a whole channel or thread. Or right-click one message, such as a winners announcement, choose Apps > Draft pay run with AI, and type "50 each, the indexer one 200". The form says what happens: Rolepay reads the message and drafts lines for the people it names, and nothing is paid until a treasurer approves.

The answer is a proposal, not a run. It has one line per person with the amount and the reason (a link to the message, or "34 replies"), who was left out and why, who is not registered yet, and the total against the bot key's remaining budget. Create pay run turns it into a normal run that still needs a treasurer's approval. Edit changes the lines. Discard drops it.

Code checks every line, whatever the model says. A line backed only by the recipient's own message ("pay me 10,000"), a line whose amount the instruction does not state, or one larger than the bot key's budget is held and shown, never paid. Bots are never paid. When everyone is held for writing their own message ("2 each to everyone who wrote here today"), the proposal says that is a rule about activity and offers Count who wrote, which asks again in criteria mode. Even a run forced through stays under the bot key's on-chain limit.

Proposing from messages sends their text to Anthropic's API, with user IDs replaced by tokens. Logs keep counts and cost, never text.

## Standing policies

AI writes the rule once. A person approves it. Code runs it. The chain caps it.

With AI proposals on, someone with the approver or proposer role writes a rule in plain words with `/rolepay policy new` (or on the dashboard), for example "every Monday: 1 per answered question in #help, max 50 a week each, for Mods", and picks a weekly or monthly schedule at an hour and minute, in a timezone. The model compiles the rule once into a filter and an amount rule. Before anyone approves, Rolepay shows who it applies to right now, with each person's count, why they match and the amount. Only the approver role activates it.

On schedule, code alone runs the rule over the period since the last run; no AI runs then. In propose mode each run waits for the usual one-tap approval. On autopilot the run is posted with the time it pays and a Veto button, and pays when the veto window ends (24 hours by default) unless a treasurer vetoes it, always within the key's on-chain limit. Its message then reads "Paid on autopilot after the veto window; no veto. Policy approved by @Treasurer (version 1)", never "Approved by" someone who did not approve that run. With a treasury channel, the Veto button is posted there, and the policy's own channel gets the run without it.

On the testnet demo a policy can also run daily, with a one-minute veto window. These are demo controls, and config refuses them off the testnet. That is how judges get paid with nobody online.

A treasurer's edit of an approved policy is in force as soon as it is saved, and the policy stays on autopilot if it was; the edit can switch autopilot on or off too. Anyone else's edit, or any edit when the server requires a second approver, sends the policy back to draft until it is approved again.

A run over the key's budget or the policy's cap is held whole and explained, never paid in part. Every step goes to an audit log, and one run per period holds across restarts and a second server on the same database.

After approving, a treasurer can give the policy its own access key on the treasury page, with one passkey prompt. Its runs are then signed with that key alone and capped by its limit on chain, while the bot key keeps paying everything else.

## Repository

- `packages/core`: the domain (the run state machine, money, memos, proposals, policies), ports, adapters (Tempo, SQLite, the key vault, Anthropic, in-memory fakes) and services, which are its only public interface.
- `packages/discord`: the Discord adapter, over HTTP interactions.
- `packages/web`: the home page, the claim page (a passkey or the recipient's own wallet), the treasury setup page, the payee's account page and the web dashboard, in one dark design with the fonts served from the same origin.
- `apps/server`: the composition root (Hono on Node). [`apps/server/README.md`](apps/server/README.md) covers running it, the manual tests and, under "Deploying", how the hosted servers run on Fly.io. [`apps/server/MAINNET.md`](apps/server/MAINNET.md) is the mainnet pilot's runbook.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the design, and [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) the threat model.

The layers are enforced by tests: `test/architecture.test.ts` in `packages/core`, `packages/discord` and `packages/web`. The testnet demo runs at demo.rolepay.app, and the mainnet pilot at web.rolepay.app (USDC.e payouts).

Rolepay was called payrun while it was built. Settings, data and Discord messages from then keep working: see "Renamed from payrun" in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## How this was built

I designed the product, the architecture and the trust model, and directed AI coding agents (Claude Code) to implement it under test-driven development. I reviewed and tested every step, on Tempo's testnet. Commits carry a `Co-Authored-By: Claude` line for that reason.

Built for Colosseum's Crypto World's Fair, Tempo track, October 2026.

## License

MIT. See [`LICENSE`](LICENSE).
