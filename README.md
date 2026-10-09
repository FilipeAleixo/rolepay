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

Rolepay pays the people who run a Discord community (moderators, staff, bounty winners) in stablecoins on [Tempo](https://tempo.xyz), from Discord. Today that usually means working out who did what by hand in a spreadsheet, waiting for enough multisig signers, and paying people who each need a wallet and gas. With Rolepay, the list comes from Discord, a treasurer approves with one button, one transaction pays everyone, and the people paid need nothing but a passkey.

![A real pay run on Tempo mainnet: started in Discord, approved in the treasury channel, the payee's balance updating live, the receipt by DM, and the transaction on the explorer](docs/img/rolepay-demo.gif)

## For judges

### What to look at in 3 minutes

1. **The videos:** [the pitch](https://youtu.be/eYC79TOwGdY) (2:48) and [the product demo](https://youtu.be/VvBoJemKTLU) (2:24).
2. **Get paid on the testnet demo, with nobody online.** Join the demo server at [discord.gg/tCuABJt72P](https://discord.gg/tCuABJt72P), run `/payee link` in #start-here, create your passkey from the link, and react ✅ to the welcome post. Every day at 16:00 UTC a standing policy pays 1 test AlphaUSD to each new payee who did, on autopilot and within its key's on-chain limit, with a DM receipt. It takes about two minutes of your time. The steps are in [Try it](#try-it).
3. **A pay run on Tempo mainnet.** [The first one](https://explore.tempo.xyz/tx/0x3cde4de2241315c563ed2316ba859ed763b2a669fcec8811620da25a95761593), on 8 October 2026, paid 1 USDC.e from the pilot community's treasury to a member's passkey account. A treasurer approved it in Discord, the bot's access key signed it as one `transferWithMemo`, and the fee, 0.00005 pathUSD, came out of the key's separate fee budget. The pilot's runbook is [`apps/server/MAINNET.md`](apps/server/MAINNET.md).
4. **The chain refusing an over-limit batch, with Rolepay's own checks skipped.** [The reverted transaction on Moderato](https://explore.testnet.tempo.xyz/tx/0xa29ba08c3162e427cea7008f5fcf902f439eef6c84da27458cc659cf8c0c8ee0), sent by [`protocolLimit.chain.test.ts`](packages/core/test/protocolLimit.chain.test.ts). Each line fits the key's limit on its own. The batch does not, so it reverts whole and nobody is paid.
5. **What can go wrong, and what stops it:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

Rolepay runs in two places. The testnet demo at [demo.rolepay.app](https://demo.rolepay.app) uses test dollars and has every feature on. The mainnet pilot at [web.rolepay.app](https://web.rolepay.app) pays real USDC.e in a small pilot community, with AI proposals and preferred stablecoins off.

### What's different

A Safe keeps a community's money safe, but it does not know who did the work. Rolepay works out who gets paid from what happened in Discord, and pays them all with one approval, to people who need nothing but a passkey.

- **The list comes from Discord.** A role, a few names, a right-click on a message, or plain words to the AI. Code checks every line, and a treasurer approves.
- **One approval, one transaction.** Everyone in a run is paid in one batched transaction on Tempo, with a memo on every line and a receipt by DM for each person.
- **Recipients need only a passkey.** It is the whole account: no wallet, no seed phrase, no gas token. Each person can be paid in the stablecoin they prefer, swapped in the same transaction.
- **A multisig's guardrails, without the multisig.** The money stays in the community's own Tempo account, and its root key is the treasurer's passkey. The bot holds only an access key that the chain itself caps, with an expiry, a limit per period and one allowed call. Over the limit, the chain refuses the whole batch.
- **Pay that runs on its own.** A rule written once in plain words, approved by a person and run by code on schedule, with a veto window and, if you want, a budget of its own on chain.

Spending limits and batch payouts exist on other chains as Safe modules and tools. On Tempo they are part of the account and compose in one transaction, for under a cent per payout. Every claim here, with its code, its tests and its transactions on the explorer, is in [How Rolepay works](docs/HOW-IT-WORKS.md).

## Try it

The demo runs on Tempo's Moderato testnet at <https://demo.rolepay.app>, with test dollars only.

### As a recipient, with nobody else online

1. Join the [demo Discord server](https://discord.gg/tCuABJt72P) and run `/payee link` in #start-here. Only you see the reply.
2. Open the link, press **Create my passkey (no wallet needed)**, and confirm with your fingerprint or face. That is your Tempo account: no wallet, no seed phrase, nothing to install, and no gas token. Being paid is free; sending it on later costs about a cent on mainnet, paid in the stablecoin you send (on the demo a sponsor pays). If you already have a wallet on Tempo, such as MetaMask, press **Use a wallet I already have** instead and sign the message it shows. Signing costs nothing and moves no money, and you are paid at that address.
3. React ✅ to the welcome post in #start-here.
4. Wait for the next daily run, at 16:00 UTC. A standing policy pays 1 AlphaUSD to every registered payee who reacted ✅ to the welcome post and has never been paid. It was written once with AI and approved by a treasurer; code runs it now, with no AI and nobody online. The run is posted in #payouts, waits out a one-minute veto window, then pays everyone in one batched transaction, capped by its key's on-chain limit. The Veto button is in the treasurers' private channel, so #payouts shows the run with no button you cannot use. You are paid once: after that you no longer match "never paid".
5. You get a DM receipt with your amount and the transaction link, if your privacy settings for the demo server allow direct messages from server members. The payment lands either way. On Tempo's explorer the transaction shows everyone paid in one batch, each line with its memo.

If you used a passkey, open your account page from **Your account** in the receipt, or from **Payee account** on the [demo's home page](https://demo.rolepay.app), and sign in with the same passkey. It shows your balance and each payment as it arrives, lets you choose the stablecoin you would rather be paid in, and lets you send money on.

### As a treasurer

Add the demo bot to a Discord server you own with **Add to your server** on the [demo's home page](https://demo.rolepay.app). Create a `Treasurer` role and a private `treasury` channel, run `/rolepay setup approver_role:@Treasurer`, create the treasury with your passkey on the page it links, and authorise the bot's capped key. Then `/rolepay new amount:1 role:@Mods` starts a run, and **Approve and pay** in #treasury pays everyone in one transaction. The full steps are in [How Rolepay works](docs/HOW-IT-WORKS.md#setting-up-as-a-treasurer-in-full).

## Go deeper

- [How Rolepay works](docs/HOW-IT-WORKS.md): each feature with its code, tests and on-chain proofs, how to run the 1,998 tests and the chain suites, the trust model, AI proposals and standing policies.
- [The threat model](docs/THREAT-MODEL.md): every threat, its mitigation, and what is left.
- [The architecture](docs/ARCHITECTURE.md).
- [Running your own Rolepay](apps/server/README.md), and [the mainnet pilot's runbook](apps/server/MAINNET.md).

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
