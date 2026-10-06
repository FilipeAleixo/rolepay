# @payrun/server

The payrun server: Hono on Node, the composition root over `@payrun/core`, `@payrun/discord` and `@payrun/web`. It serves the Discord interactions endpoint (`POST /discord/interactions`), `GET /health`, the recipient claim page (`/claim/:token`), the treasurer setup page (`/setup/:token`), the passkey ceremonies (`/webauthn/*`) and the client bundle (`/assets/payrun.js`), and runs the crash-recovery sweep every 30 seconds.

Everything below is testnet (Moderato). Secrets go only in the repo-root `.env`, which is gitignored.

## One-time setup (about 20 minutes)

You need: the Discord desktop app, a private test server where you are the owner, a second Discord account that is a member of it, Chrome or Safari (for passkeys), and `ngrok` (installed and logged in on this Mac; `cloudflared` is not installed).

1. **Install and check.** From the repo root: `pnpm install`, then `pnpm typecheck && pnpm test` (all green, no network).

2. **Create the Discord application.** Go to <https://discord.com/developers/applications>, then New Application, name it `payrun dev`.
   - General Information: copy **Application ID** and **Public Key**.
   - Bot: press **Reset Token** and copy the token (shown once). Turn **Public Bot** off so only you can invite it.
   - Bot, Privileged Gateway Intents: leave all three **off**. payrun needs none (it looks up members one by one with Get Guild Member and reads the server name with Get Guild; neither needs an intent).

3. **Fill in `.env`** (repo root; it already holds the testnet keys from the chain test). Add:

   ```
   DISCORD_APP_ID=<Application ID>
   DISCORD_PUBLIC_KEY=<Public Key>
   DISCORD_BOT_TOKEN=<bot token>
   DISCORD_DEV_GUILD_ID=<your test server ID>
   PUBLIC_URL=https://<tunnel host>
   ```

   The server ID: Discord, User Settings, Advanced, turn on Developer Mode; then right-click your test server and Copy Server ID. `PUBLIC_URL` comes from step 6; leave it for now. It is the origin only (no `/claim`), and passkeys are bound to its host.

4. **Invite the bot** to the test server. Open (with your Application ID):

   ```
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=19456
   ```

   Scopes `bot` and `applications.commands`; permissions 19456 = View Channels + Send Messages + Embed Links (used to update a pay run's message after a restart, or post in the channel once an interaction token has expired). DMs need no permission.

5. **Register the slash commands:** `pnpm register-commands`. With `DISCORD_DEV_GUILD_ID` set they appear in your test server at once (globally they can take a while). Expect `Registered 2 commands (guild ...)`. Run it again whenever the commands change (the `/payrun setup` options changed in WP5).

6. **Start a tunnel** in its own terminal: `ngrok http 8787` (if ngrok reports connection refused, use `ngrok http 127.0.0.1:8787`). It prints a forwarding URL such as `https://<name>.ngrok-free.app`. Put `PUBLIC_URL=https://<name>.ngrok-free.app` in `.env`.
   - A free ngrok account has one static domain, so the URL usually stays the same. If it ever changes, update `PUBLIC_URL`, restart the server and repeat step 8.
   - Passkeys are bound to that tunnel host: one made on `https://<name>.ngrok-free.app` only works there. That is fine for testing. The production claim domain is still Filipe's decision (passkeys bind to it for good).
   - The first time a browser opens a tunnel page, ngrok shows a "You are about to visit" warning: press Visit Site. Discord's requests to the interactions endpoint are not affected.

7. **Start the server** in another terminal: `pnpm dev`. It logs `{"event":"listening","url":"http://127.0.0.1:8787",...,"publicUrl":"https://<name>.ngrok-free.app","passkeyRpId":"<name>.ngrok-free.app"}`. Check `curl http://127.0.0.1:8787/health` gives `{"ok":true,"network":"moderato","jobsInFlight":0}`. (`pnpm dev` watches the code, not `.env`: restart it after editing `.env`.)

8. **Point Discord at it.** Developer Portal, General Information, **Interactions Endpoint URL**: `https://<name>.ngrok-free.app/discord/interactions`, then Save Changes. Discord sends a signed PING and a badly signed request before it accepts the URL, so the server must be running. A red error here usually means a wrong `DISCORD_PUBLIC_KEY` or a stopped tunnel.

9. **Roles in the test server.** Server Settings, Roles: create `Treasurer` and give it to yourself. Create `Mods` and give it to yourself and the second account. Leave the second account without `Treasurer`.

## Manual test (about 15 minutes)

Run these in a channel of the test server. Ephemeral means only the person who ran it sees the reply.

1. **Setup.** As yourself (Manage Server and Treasurer): `/payrun setup approver_role:@Treasurer`. Expect an ephemeral "payrun setup: <server name>" card saying one step is left, with a **Treasury page** link (only for you, valid 30 minutes). Nothing is registered yet.
2. **Create the treasury.** Open the link in Chrome or Safari. Press **Create the treasury passkey** and let the browser save the passkey. Expect "Signed in as the treasury" and the deposit address. Press **Get testnet funds**: the balance shows AlphaUSD.
3. **Authorise the bot key with the passkey.** Keep the suggested limit (100 AlphaUSD, resets every 30 days, expires after 30 days) or change it, press **Authorise the bot key with my passkey** and confirm the passkey prompt. Expect "The bot key is active" with a transaction link (the fee is paid by the sponsor). Run `/payrun setup` again: the key shows Active with 100 AlphaUSD left, and "Ready".
4. **Register two payees.** As yourself: `/payee link`. Open the one-time link and press **Create my passkey**. Expect "You will be paid here" with the account address, nothing to install. Do the same from the second account (another browser profile or device is the most realistic; the same browser also works, it saves a second passkey). Someone who already has a payrun passkey on this tunnel host uses **I already have a payrun passkey**.
5. **A run from a list.** As yourself: `/payrun new amount:1 users:@you @second=2 note:Test run`. Expect a public "Pay run awaiting approval" embed: two lines, total 3 AlphaUSD, Approve and Cancel. (Pick the people from the @ suggestions so they arrive as mentions. If they do not, user IDs work too: right-click a user, Copy User ID.)
6. **A bystander cannot approve.** From the second account, click Approve. Expect an ephemeral "Only members with @Treasurer can approve". Nothing changes.
7. **Approve.** As yourself, click Approve. The embed turns into "Approved, paying..." with no buttons, then within seconds "Paid" with a View transaction button. Both accounts get a DM receipt with their amount and the transaction link.
8. **Check the chain.** Open the transaction: one transaction from the passkey treasury, two `TransferWithMemo` events (1 and 2 AlphaUSD), and the fee paid by the sponsor.
9. **A run from a role.** `/payrun new amount:0.5 role:@Mods`. Expect both registered members on the review. Click Cancel: it shows "Cancelled".
10. **Status and export.** `/payrun status` shows recent runs and the bot key (97 AlphaUSD left). `/payrun export` sends a CSV of the latest run: one row per person, status `paid`, the tx hash and explorer link.
11. **Over the limit.** `/payrun new amount:200 users:@you`, then Approve. Expect "Approved, not paid yet: This run needs 200 AlphaUSD but the bot key has 97 AlphaUSD left this period", with Retry and Cancel, and nothing sent on chain. Cancel it.
12. **Revoke with the passkey.** `/payrun setup` for a fresh link, open it, **Sign in with the treasury passkey**, then **Revoke the bot key** and confirm. Expect "The bot key is revoked", and `/payrun setup` shows the key revoked. Approving a new run now says the bot has no active key. Authorise a new key on the page to carry on.
13. **Fee budget (optional).** `/payrun setup fees:fee_budget`. The card shows fees from a fee budget in pathUSD and says the key needs a fee budget. On the treasury page the form now has a fee budget field: authorise a new key. The next run pays its fee in pathUSD from the treasury (the faucet funds pathUSD too), and the payout limit stays exact. `/payrun setup fees:sponsor` switches back.

Optional: stop the server with Ctrl-C right after clicking Approve on a new run, start it again and wait up to 30 seconds. The recovery sweep finishes a run that was executing, updates its message in the channel and DMs the receipts (once); a run that was only approved shows a Retry button in `/payrun status`. Either way it is paid at most once.

**Dev shortcut (no passkey):** `pnpm dev:treasury` prints and funds a throwaway treasury whose key is in `.env`; `/payrun setup treasury:<that address> approver_role:@Treasurer` registers it and issues a key; `pnpm dev:authorize-key <server ID>` authorises it. Use a different test server for this, because a server's treasury cannot be changed once registered.

## Reference

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the server with reload on code changes |
| `pnpm start` | Runs the server without reload |
| `pnpm register-commands` | Registers the slash commands (guild if `DISCORD_DEV_GUILD_ID` is set, else global) |
| `pnpm dev:treasury` | Testnet dev shortcut: prints and funds the dev treasury (`PAYRUN_TEST_ROOT_PRIVATE_KEY`) |
| `pnpm dev:authorize-key <guildId>` | Testnet dev shortcut: the dev treasury authorises the pending bot key |
| `pnpm --filter @payrun/server test` | Server tests (no network) |
| `pnpm --filter @payrun/server test:chain` | Opt-in: the Discord flow over HTTP on Moderato, fake Discord REST |
| `pnpm test:e2e` | Opt-in: Playwright in Chromium with a virtual passkey authenticator, the real server on `http://localhost:8799`, Moderato |

Settings are listed in the repo-root `.env.example`. The SQLite file defaults to `payrun.db` at the repo root, shared by the server and the dev scripts; it also holds the passkey credentials and sessions (so returning users can sign in after a restart). If something looks stuck, the server logs one JSON line per event (`interaction_error`, `job_error`, `recovery`, `recovery_notify_error`); they never include tokens or keys.
