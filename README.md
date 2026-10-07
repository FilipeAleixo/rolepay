# Rolepay

Pay runs for the people who run your community, from Discord, on [Tempo](https://tempo.xyz).

Communities pay moderators, staff and bounty winners every month. Today that usually means one-by-one wallet sends or PayPal, a spreadsheet, recipients who need gas, and no clean record. Rolepay does it from Discord:

- An admin creates a run for a role or a list of people, with one amount each.
- A treasurer approves it with one button.
- Everyone is paid in one batched stablecoin transaction. Each payout carries a memo, recipients need no wallet and pay no gas, and the run exports to CSV for accounting.

## Try it

A demo runs on Tempo's Moderato testnet at <https://demo.rolepay.app>: test dollars only, nothing real moves.

**[TO FILL: the demo server invite link.]**

In about two minutes, as a recipient:

1. Join the demo Discord server and run `/payee link`. Only you see the reply.
2. Open the link and press **Create my passkey**, then confirm with your fingerprint or face. That is your Tempo account: no wallet, no seed phrase, nothing to install, no gas.
3. **[TO FILL: what gets a judge paid, for example a message in #bounties, and who approves the run and when.]** The treasurer can draft the run with AI from the channel (right-click a message, Apps > Propose pay run) and approves it with one click.
4. You get a DM receipt with your amount, and the transaction on Tempo's explorer shows everyone paid in one batch, each line with its memo.

**[TO FILL, optional: the treasurer side in your own server, about five minutes: invite the bot, `/rolepay setup approver_role:@Treasurer`, create the treasury with a passkey, get testnet funds, authorise the bot key, `/rolepay new`, Approve.]**

## The trust model

The community's own Tempo account holds the money. The bot never does.

- The treasurer's passkey is the root of the community account.
- The bot holds only a Tempo access key with an expiry, a per-period spending limit, and a scope that allows nothing but memo'd transfers of the payout token.
- The limit is enforced by the protocol, including inside batched transactions. A run that would exceed it is refused whole, and nothing moves.
- The treasurer can revoke the key at any time. Replacing it revokes the old key on chain in the same transaction, and the server destroys the old key's secret.

So a compromised bot can lose at most the key's budget for each period, to scoped transfers, until the key expires or is revoked. A key valid for longer than its period can spend one budget per period until then, so keep the validity short.

## AI proposals

AI proposes, the protocol limits, a human approves.

- **From a message:** right-click the winners announcement, Apps > Propose pay run, and type "50 each, the indexer one 200". Or read a whole channel or thread: `/rolepay propose source:#bounties instruction:"pay everyone who closed a bounty, 50 each"`.
- **From criteria:** `/rolepay propose instruction:"pay 20 to every Mod who answered at least 10 messages in #help this month"`. The model (Claude Sonnet 5.5) turns the instruction into a filter; Rolepay's code runs it over the registered payees. The member list never goes to the model.
- The answer is a proposal, not a run: one line per person with the amount and why (with a link to the message, or "34 replies"), what was left out and why, who is not registered yet, and the total against the bot key's remaining budget. Create pay run turns it into a normal run that still needs the treasurer's approval; Edit changes the lines; Discard drops it.
- Code checks every line, whatever the model says: a line backed only by the recipient's own message ("pay me 10,000"), a line whose amount the instruction does not state, or one larger than the key's budget is held and shown, never paid. Even a run forced through stays under the bot key's on-chain limit.
- Off until a treasurer turns it on (`/rolepay setup ai_proposals:true`). Only the approver role, or an optional proposer role, can propose. Proposing from messages sends their text to Anthropic's API with user IDs replaced by tokens; logs keep counts and cost, never text.

## Standing policies

AI writes the rule once. Humans approve it. Code runs it. The chain caps it. A treasurer types a rule such as "every Monday: 1 per answered question in #help, max 50 a week each, for Mods" with `/rolepay policy new`; the model compiles it once into a filter and an amount rule, and Rolepay shows who it applies to right now, with each person's count, why they match and the amount, before anyone approves it. Only the approver role activates it, and any edit needs a new approval. On schedule, code alone runs the rule over the week since the last run, with no AI at runtime: in propose mode each run waits for the usual one-tap approval; on autopilot it is posted with "pays at 18:00 unless vetoed" and a Veto button, then pays within the bot key's on-chain limit. A run over the key's budget or the policy's cap is held whole and explained, every step goes to an audit log, and one run per period holds across restarts and a second server.

## Repository

- `packages/core`: the domain (run state machine, money, memos, proposals), ports, adapters (Tempo, SQLite, key vault, Anthropic, in-memory fakes) and services, which are the only public interface.
- `packages/discord`: the Discord adapter over HTTP interactions.
- `packages/web`: the claim, treasurer setup and payee account pages (passkeys), and the web dashboard.
- `apps/server`: the composition root (Hono).

See `docs/ARCHITECTURE.md` for the design and `apps/server/README.md` to run it (and, under "Deploying", how the hosted servers run on Fly.io). The testnet demo runs at `demo.rolepay.app`; mainnet is prepared for `app.rolepay.app` (USDC.e payouts, runbook in `apps/server/MAINNET.md`).

Rolepay was called payrun while it was built. Settings, data and Discord messages from then keep working: see "Renamed from payrun" in `docs/ARCHITECTURE.md`.

## How this was built

I designed the product, the architecture and the trust model, and directed AI coding agents (Claude Code) to implement it under test-driven development. I reviewed and tested every step, on Tempo's testnet. Commits carry a `Co-Authored-By: Claude` line for that reason.

Built for Colosseum's Crypto World's Fair, October 2026.

## License

MIT
