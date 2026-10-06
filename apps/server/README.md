# @payrun/server

The payrun server: Hono on Node, the composition root over `@payrun/core` and `@payrun/discord`. It serves the Discord interactions endpoint (`POST /discord/interactions`), `GET /health`, a testnet-only dev claim page (`/claim/:token`), and runs the crash-recovery sweep every 30 seconds.

Everything below is testnet (Moderato). Secrets go only in the repo-root `.env`, which is gitignored.

## One-time setup (about 20 minutes)

You need: the Discord desktop app, a private test server where you are the owner, a second Discord account that is a member of it, and `cloudflared` (`brew install cloudflared`).

1. **Install and check.** From the repo root: `pnpm install`, then `pnpm typecheck && pnpm test` (all green, no network).

2. **Create the Discord application.** Go to <https://discord.com/developers/applications>, then New Application, name it `payrun dev`.
   - General Information: copy **Application ID** and **Public Key**.
   - Bot: press **Reset Token** and copy the token (shown once). Turn **Public Bot** off so only you can invite it.
   - Bot, Privileged Gateway Intents: leave all three **off**. payrun needs none (it looks up members one by one with Get Guild Member, which needs no intent).

3. **Fill in `.env`** (repo root; it already holds the testnet keys from the chain test). Add:

   ```
   DISCORD_APP_ID=<Application ID>
   DISCORD_PUBLIC_KEY=<Public Key>
   DISCORD_BOT_TOKEN=<bot token>
   DISCORD_DEV_GUILD_ID=<your test server ID>
   PAYRUN_DEV_CLAIM=true
   CLAIM_BASE_URL=https://<tunnel host>/claim
   ```

   The server ID: Discord, User Settings, Advanced, turn on Developer Mode; then right-click your test server and Copy Server ID. `CLAIM_BASE_URL` comes from step 6; leave it for now.

4. **Invite the bot** to the test server. Open (with your Application ID):

   ```
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=19456
   ```

   Scopes `bot` and `applications.commands`; permissions 19456 = View Channels + Send Messages + Embed Links (only used to post a result in the channel if an interaction token has expired). DMs need no permission.

5. **Register the slash commands:** `pnpm register-commands`. With `DISCORD_DEV_GUILD_ID` set they appear in your test server at once (globally they can take a while). Expect `Registered 2 commands (guild ...)`.

6. **Start a tunnel** in its own terminal: `cloudflared tunnel --url http://127.0.0.1:8787`. It prints `https://<random>.trycloudflare.com`. Put `CLAIM_BASE_URL=https://<random>.trycloudflare.com/claim` in `.env`. A quick tunnel gets a new URL every time it starts: when it changes, update `CLAIM_BASE_URL`, restart the server and repeat step 8.

7. **Start the server** in another terminal: `pnpm dev`. It logs `{"event":"listening","url":"http://127.0.0.1:8787",...}`. Check `curl http://127.0.0.1:8787/health` gives `{"ok":true,"network":"moderato","jobsInFlight":0}`. (`pnpm dev` watches the code, not `.env`: restart it after editing `.env`.)

8. **Point Discord at it.** Developer Portal, General Information, **Interactions Endpoint URL**: `https://<random>.trycloudflare.com/discord/interactions`, then Save Changes. Discord sends a signed PING and a badly signed request before it accepts the URL, so the server must be running. A red error here usually means a wrong `DISCORD_PUBLIC_KEY` or a stopped tunnel.

9. **Roles in the test server.** Server Settings, Roles: create `Treasurer` and give it to yourself. Create `Mods` and give it to yourself and the second account. Leave the second account without `Treasurer`.

10. **The dev treasury:** `pnpm dev:treasury`. It prints the treasury address (public) and tops it up with testnet AlphaUSD from the faucet. It never prints the key.

## Manual test (about 10 minutes)

Run these in a channel of the test server. Ephemeral means only the person who ran it sees the reply.

1. **Setup.** As yourself: `/payrun setup treasury:<address from dev:treasury> approver_role:@Treasurer`. Expect an ephemeral "payrun setup" card: treasury, AlphaUSD, sponsored fees, Treasurer as approver, and the bot key "Waiting for the treasury to authorise it" with its limit (100 AlphaUSD per 30 days), plus the exact command to run next.
2. **Authorise the bot key** (what the treasurer's passkey will do later): `pnpm dev:authorize-key <server ID>`. Expect "Bot key 0x... is active" and an explorer link. Run `/payrun setup` again: the key shows Active with 100 AlphaUSD left, and "Ready".
3. **Register two payees.** As yourself: `/payee link`. Expect an ephemeral one-time link. Open it, leave the address empty (a fresh throwaway testnet address) or paste your own, press Register. Do the same from the second account.
4. **A run from a list.** As yourself: `/payrun new amount:1 users:@you @second=2 note:Test run`. Expect a public "Pay run awaiting approval" embed: two lines, total 3 AlphaUSD, Approve and Cancel. (Pick the people from the @ suggestions so they arrive as mentions. If they do not, user IDs work too: right-click a user, Copy User ID.)
5. **A bystander cannot approve.** From the second account, click Approve. Expect an ephemeral "Only members with @Treasurer can approve". Nothing changes.
6. **Approve.** As yourself (Treasurer), click Approve. The embed turns into "Approved, paying..." with no buttons, then within seconds "Paid" with a View transaction button. Both accounts get a DM receipt with their amount and the transaction link.
7. **Check the chain.** Open the transaction: one transaction, two `TransferWithMemo` events (1 and 2 AlphaUSD), and the fee paid by the sponsor, not the treasury.
8. **A run from a role.** `/payrun new amount:0.5 role:@Mods`. Expect both registered members on the review. Click Cancel: it shows "Cancelled".
9. **Status and export.** `/payrun status` shows recent runs and the bot key (97 AlphaUSD left). `/payrun status run:` offers your runs to pick from. `/payrun export` sends a CSV of the latest run; open it: one row per person, status `paid`, the tx hash and explorer link.
10. **Over the limit.** `/payrun new amount:200 users:@you`, then Approve. Expect "Approved, not paid yet: This run needs 200 AlphaUSD but the bot key has 97 AlphaUSD left this period", with Retry and Cancel, and nothing sent on chain. Cancel it.

Optional: stop the server with Ctrl-C right after clicking Approve on a new run, start it again, and run `/payrun status`. The recovery sweep reconciles a run that was executing; a run that was only approved shows a Retry button. Either way it is paid at most once.

## Reference

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the server with reload on code changes |
| `pnpm start` | Runs the server without reload |
| `pnpm register-commands` | Registers the slash commands (guild if `DISCORD_DEV_GUILD_ID` is set, else global) |
| `pnpm dev:treasury` | Testnet: prints and funds the dev treasury (`PAYRUN_TEST_ROOT_PRIVATE_KEY`) |
| `pnpm dev:authorize-key <guildId>` | Testnet: the dev treasury authorises the pending bot key |
| `pnpm --filter @payrun/server test` | Server tests (no network) |
| `pnpm --filter @payrun/server test:chain` | Opt-in: the Discord flow over HTTP on Moderato, fake Discord REST |

Settings are listed in the repo-root `.env.example`. The SQLite file defaults to `payrun.db` at the repo root, shared by the server and the dev scripts. If something looks stuck, the server logs one JSON line per event (`interaction_error`, `job_error`, `recovery`); they never include tokens or keys.
