# payrun

Pay runs for the people who run your community, from Discord, on [Tempo](https://tempo.xyz).

Communities pay moderators, staff and bounty winners every month. Today that usually means one-by-one wallet sends or PayPal, a spreadsheet, recipients who need gas, and no clean record. payrun does it from Discord:

- An admin creates a run for a role or a list of people, with one amount each.
- A treasurer approves it with one button.
- Everyone is paid in one batched stablecoin transaction. Each payout carries a memo, recipients need no wallet and pay no gas, and the run exports to CSV for accounting.

## The trust model

The community's own Tempo account holds the money. The bot never does.

- The treasurer's passkey is the root of the community account.
- The bot holds only a Tempo access key with an expiry, a per-period spending limit, and a scope that allows nothing but memo'd transfers of the payout token.
- The limit is enforced by the protocol, including inside batched transactions. A run that would exceed it is refused whole, and nothing moves.
- The treasurer can revoke the key at any time. Replacing it revokes the old key on chain in the same transaction, and the server destroys the old key's secret.

So a compromised bot can lose at most the key's budget for each period, to scoped transfers, until the key expires or is revoked. A key valid for longer than its period can spend one budget per period until then, so keep the validity short.

## AI proposals

AI proposes, the protocol limits, a human approves.

- **From a message:** right-click the winners announcement, Apps > Propose pay run, and type "50 each, the indexer one 200". Or read a whole channel or thread: `/payrun propose source:#bounties instruction:"pay everyone who closed a bounty, 50 each"`.
- **From criteria:** `/payrun propose instruction:"pay 20 to every Mod who answered at least 10 messages in #help this month"`. The model (Claude Opus 5.5) turns the instruction into a filter; payrun's code runs it over the registered payees. The member list never goes to the model.
- The answer is a proposal, not a run: one line per person with the amount and why (with a link to the message, or "34 replies"), what was left out and why, who is not registered yet, and the total against the bot key's remaining budget. Create pay run turns it into a normal run that still needs the treasurer's approval; Edit changes the lines; Discard drops it.
- Code checks every line, whatever the model says: a line backed only by the recipient's own message ("pay me 10,000"), a line whose amount the instruction does not state, or one larger than the key's budget is held and shown, never paid. Even a run forced through stays under the bot key's on-chain limit.
- Off until a treasurer turns it on (`/payrun setup ai_proposals:true`). Only the approver role, or an optional proposer role, can propose. Proposing from messages sends their text to Anthropic's API with user IDs replaced by tokens; logs keep counts and cost, never text.

## Repository

- `packages/core`: the domain (run state machine, money, memos, proposals), ports, adapters (Tempo, SQLite, key vault, Anthropic, in-memory fakes) and services, which are the only public interface.
- `packages/discord`: the Discord adapter over HTTP interactions.
- `packages/web`: the claim and treasurer setup pages (passkeys).
- `apps/server`: the composition root (Hono).

See `docs/ARCHITECTURE.md` for the design and `apps/server/README.md` to run it.

## How this was built

I designed the product, the architecture and the trust model, and directed AI coding agents (Claude Code) to implement it under test-driven development. I reviewed and tested every step, on Tempo's testnet. Commits carry a `Co-Authored-By: Claude` line for that reason.

Built for Colosseum's Crypto World's Fair, October 2026.

## License

MIT
