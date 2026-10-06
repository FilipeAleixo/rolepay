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

## Repository

- `packages/core`: the domain (run state machine, money, memos), ports, adapters (Tempo, SQLite, key vault, in-memory fakes) and services, which are the only public interface.
- `packages/discord`: the Discord adapter over HTTP interactions.
- `packages/web`: the claim and treasurer setup pages (passkeys).
- `apps/server`: the composition root (Hono).

See `docs/ARCHITECTURE.md` for the design and `apps/server/README.md` to run it.

## How this was built

I designed the product, the architecture and the trust model, and directed AI coding agents (Claude Code) to implement it under test-driven development. I reviewed and tested every step, on Tempo's testnet. Commits carry a `Co-Authored-By: Claude` line for that reason.

Built for Colosseum's Crypto World's Fair, October 2026.

## License

MIT
