# Rolepay on mainnet: the pilot runbook

This is how to bring up the production Rolepay at <https://app.rolepay.app> on Tempo mainnet and run a small real-money pilot: two or three people paid real stablecoins, from a treasury of about US$20 to 50. Everything in the repo is ready (`fly.app.toml`, the config guards, the pages); what is left are the steps only you can do: a Discord application, a Fly app, secrets, DNS, and funding.

**Time:** about 1.5 hours, most of it waiting on a build, a certificate and a bridge. Do steps 1 to 7 the day before the pilot, so the day itself is only the pay run (step 8).

The same flow ran end to end on the Moderato testnet with the sponsor turned off, exactly as on mainnet (`apps/server/e2e/mainnetPath.spec.ts`, `pnpm test:e2e`): the treasurer's passkey authorised the key paying its fee in pathUSD, the bot paid from its pathUSD fee budget, and the payee sent money on from the account page paying the fee in the token sent.

## What is decided, and why

| | Value | Source |
| --- | --- | --- |
| Network | Tempo mainnet, chain 4217, RPC `https://rpc.tempo.xyz`, explorer `https://explore.tempo.xyz` | [connection details](https://tempo.xyz/developers/docs/quickstart/connection-details) |
| Payout token | **USDC.e** `0x20c000000000000000000000b9537d11c60e8b50`, 6 decimals: Circle's USDC bridged by Stargate (LayerZero) | [token list 4217](https://tokenlist.tempo.xyz/list/4217), [LayerZero guide](https://tempo.xyz/developers/docs/guide/bridge-layerzero) |
| Fee token | **pathUSD** `0x20c0000000000000000000000000000000000000`, 6 decimals: the protocol's fallback fee token | [fee spec](https://tempo.xyz/developers/docs/protocol/fees/spec-fee) |
| Fees | **fee budget**: there is no public fee sponsor on mainnet (the hosted one, `api.tempo.xyz/rpc/sponsor`, needs an API key with billing), so the bot pays each run's fee from a small pathUSD budget on its key | [sponsor guide](https://tempo.xyz/developers/docs/guide/payments/sponsor-user-fees), [fee payer API](https://tempo.xyz/developers/docs/api/fee-payer) |
| Cost of a run | about US$0.001 per transfer to an existing account, US$0.006 to a new one: a three-person run costs about two cents | [TIP-1010](https://tempo.xyz/developers/docs/protocol/tips/tip-1010) |

The USD stablecoins on mainnet (read on chain on 2026-10-07, all TIP-20 with 6 decimals and currency USD): OUSD 492M supply, USDC.e 95M, pathUSD 70M, USDT0 12M, plus smaller ones (frxUSD, cUSD, USD1 and others; the token list has them all). **Why USDC.e and not OUSD:** Tempo's docs recommend OUSD (Open USD, run by Open Standard, whose partners include Coinbase, Stripe and Visa; [OUSD guide](https://tempo.xyz/developers/docs/guide/ousd)) and it has the larger supply on Tempo, but USDC is the stablecoin recipients already know and hold, and USDC.e bridges back to native USDC on Ethereum, Base, Arbitrum and others through Stargate and Relay. Both convert 1:1 on Tempo's Stablecoin DEX. Switching later is one line (`ROLEPAY_PAYOUT_TOKEN` in `fly.app.toml`) for new communities; a registered community keeps its token.

The Fee AMM has liquidity between USDC.e, pathUSD and OUSD (read on chain), so fees paid in pathUSD (the bot, the treasury) or in USDC.e (a payee sending on) are accepted.

## Before you start

- `fly` logged in (`fly auth whoami`), Docker running (the image is built locally, as for the demo), this repo on `main` at the commit you deploy, `pnpm install` done.
- Namecheap access for `rolepay.app`.
- A browser with passkeys, ideally a **synced** passkey manager (iCloud Keychain, Google Password Manager or 1Password): the treasury passkey is the only key to the treasury. Lose it and the money stays there for good.
- About US$25 to 55 of USDC on Ethereum, Base or Arbitrum (or in a Tempo Wallet), for the treasury and a little for fees.
- The pilot server in Discord, where you have Manage Server and a role called `Treasurer` (create it and give it to yourself).

## 1. The production Discord application "Rolepay" (10 minutes)

A new application, never the dev one (`Rolepay Dev` stays with the demo).

1. <https://discord.com/developers/applications>, **New Application**, name `Rolepay`, accept, **Create**.
2. **General Information:** copy the **Application ID** and the **Public Key**. Leave the Interactions Endpoint URL empty for now (step 5: Discord checks it against the running server).
3. **Installation:** Installation Contexts, tick **Guild Install** only (untick User Install). Install Link: **None** (Discord refuses to make a bot private while it has an install link).
4. **Bot:**
   - **Reset Token**, copy the token (shown once).
   - **Public Bot: off** for the pilot, so only you can add it to a server.
   - Privileged Gateway Intents: **all three off** (Presence, Server Members, Message Content). Rolepay needs none: it looks members up one by one, and Message Content is only for `/rolepay propose source:`, which the pilot does not need.
5. **OAuth2:**
   - Redirects, **Add Redirect**: `https://app.rolepay.app/auth/discord/callback`, **Save Changes**. Discord refuses any redirect not listed here, character for character.
   - Client Secret, **Reset Secret**, copy it. This is the dashboard's "Sign in with Discord" (scopes `identify guilds`, requested by Rolepay itself; nothing to set here).

Keep the four values for step 2. The bot's invite link (step 5) asks for scopes `bot applications.commands` and permissions **84992** = View Channels (1024) + Send Messages (2048) + Embed Links (16384) + Read Message History (65536).

## 2. The Fly app, its volume and its secrets (10 minutes)

From the repo root:

```bash
fly apps create rolepay-app
fly volumes create rolepay_app_data --app rolepay-app --region iad --size 1
```

The region is `iad` (Ashburn), as the demo's since 2026-10-07: Discord's servers are in the US, and from Paris each Discord-to-server hop took 1 to 3 seconds against Discord's 3-second deadline.

The secrets, typed at hidden prompts (nothing echoed, nothing in shell history) and a **new** master key generated straight into Fly, never printed (it seals the bot keys in this app's database; never reuse the demo's or a local one). In zsh:

```zsh
read -rs "APP_ID?Application ID: "; echo
read -rs "PUBLIC_KEY?Public Key: "; echo
read -rs "BOT_TOKEN?Bot token: "; echo
read -rs "CLIENT_SECRET?OAuth2 client secret: "; echo
printf 'DISCORD_APP_ID=%s\nDISCORD_PUBLIC_KEY=%s\nDISCORD_BOT_TOKEN=%s\nROLEPAY_DISCORD_CLIENT_SECRET=%s\nROLEPAY_MASTER_KEY=%s\n' \
  "$APP_ID" "$PUBLIC_KEY" "$BOT_TOKEN" "$CLIENT_SECRET" "$(openssl rand -hex 32)" \
  | fly secrets import --app rolepay-app --stage
unset PUBLIC_KEY BOT_TOKEN CLIENT_SECRET
fly secrets list --app rolepay-app   # names and digests only
```

Keep this terminal open: `$APP_ID` is used in step 5. Secret names: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `ROLEPAY_DISCORD_CLIENT_SECRET`, `ROLEPAY_MASTER_KEY`, and optionally `ANTHROPIC_API_KEY` (AI proposals and standing policies; leave it out for the pilot unless you want them: `grep '^ANTHROPIC_API_KEY=' .env | fly secrets import --app rolepay-app --stage`). Everything else is in `fly.app.toml` and is checked by `apps/server/test/flyConfig.test.ts`.

## 3. Deploy (10 to 15 minutes, the first build is the slow part)

```bash
fly deploy -c fly.app.toml --local-only --ha=false
fly status -a rolepay-app
curl -s https://rolepay-app.fly.dev/health      # {"ok":true,"network":"mainnet","jobsInFlight":0}
fly logs -a rolepay-app --no-tail | grep '"listening"'
```

The `listening` line must say `"network":"mainnet"`, `"chainId":4217`, `"payoutToken":"0x20c000000000000000000000b9537d11c60e8b50"`, `"fees":"fee_budget 0x20c0000000000000000000000000000000000000"`, `"publicUrl":"https://app.rolepay.app"`, `"passkeyRpId":"app.rolepay.app"`. The server refuses to start if the RPC answers for another chain; a `chain_check_failed` line means the RPC did not answer at start (it keeps running; check <https://rpc.tempo.xyz> and `fly machine restart`).

## 4. DNS and the certificate (5 minutes, then a wait)

```bash
fly certs add app.rolepay.app -a rolepay-app
```

Namecheap, Domain List, `rolepay.app`, **Manage**, **Advanced DNS**, **Add New Record**: type `CNAME Record`, host `app`, value `rolepay-app.fly.dev`, TTL Automatic, save. Then `fly certs show app.rolepay.app -a rolepay-app` until the certificate is issued, and `curl -s https://app.rolepay.app/health`.

**Wait for the certificate before any passkey step.** Passkeys bind to `app.rolepay.app` for good; the pages only work there (not on `rolepay-app.fly.dev`).

## 5. Point Discord at it, register the commands, invite the bot (5 minutes)

1. Developer Portal, `Rolepay`, **General Information**, Interactions Endpoint URL: `https://app.rolepay.app/discord/interactions`, **Save Changes**. Discord sends a signed PING first; a red error means a wrong `DISCORD_PUBLIC_KEY` or the server is not up.
2. Register the commands for the production application from this checkout, without touching `.env` (the real environment wins over `.env`, so the dev application there is untouched). The pilot server's ID: Discord, User Settings, Advanced, Developer Mode on, then right-click the server, Copy Server ID.

   ```zsh
   read -rs "BOT_TOKEN?Production bot token: "; echo
   DISCORD_APP_ID=$APP_ID DISCORD_BOT_TOKEN=$BOT_TOKEN DISCORD_DEV_GUILD_ID=<pilot server ID> \
     ROLEPAY_NETWORK=mainnet ROLEPAY_ALLOW_MAINNET=true ROLEPAY_DEV_SHORTCUTS=false ROLEPAY_DEMO_CONTROLS=false \
     pnpm register-commands
   unset BOT_TOKEN
   ```

   Expect `Registered 3 commands (guild <ID>)`: `/rolepay`, `/payee` and the message command Propose pay run, with no dev or demo options. (`DISCORD_DEV_GUILD_ID=` empty registers them globally instead.)
3. Invite the bot to the pilot server: `open "https://discord.com/oauth2/authorize?client_id=$APP_ID&scope=bot+applications.commands&permissions=84992"`.

## 6. Create the treasury and authorise the bot key (15 minutes)

1. In a channel of the pilot server: `/rolepay setup approver_role:@Treasurer`. The card (only you see it) says Payout token **USDC.e**, Fees **From a fee budget in pathUSD**, and has the treasury page link (30 minutes).
2. Open it on the device and browser you will keep using. **Create the treasury passkey** (save it in your synced passkey manager). Note the treasury address.
3. Fund it (step 7). If the link has expired by then, run `/rolepay setup` again for a fresh one, and **Sign in with the treasury passkey**.
4. On the page, step 3: the suggested key is 25 USDC.e per 30 days, expiring after 14 days, with 0.5 pathUSD of fees per period. Change them if you like, read the "You will sign" line, then **Authorise the bot key with my passkey**. One prompt. Expect "The bot key is active" and a transaction on explore.tempo.xyz; the treasury paid its fee (a cent or two) in pathUSD.
5. `/rolepay setup` again: the key shows Active with 25 USDC.e left, and "Ready".

The bot can then spend at most 25 USDC.e per 30 days, only through `transferWithMemo` on USDC.e, until the key expires in 14 days or you revoke it. The treasury itself bounds everything else.

## 7. Fund the treasury (10 to 20 minutes)

Send to the treasury address, **on Tempo**:

- **USDC.e**: the pilot budget, US$20 to 50.
- **pathUSD**: about 2. Your passkey's own transactions (authorise, replace, revoke) cost a cent or two each, and the bot's fee budget draws from it (0.5 per period). If pathUSD runs out, your own transactions on the page pay in USDC.e instead, so you can always revoke the key; the bot's runs need pathUSD.

Ways onto Tempo ([getting funds](https://tempo.xyz/developers/docs/guide/getting-funds)):

- **Relay** (<https://relay.link>): from USDC on Base, Arbitrum, Ethereum, Optimism and others; destination chain Tempo, token USDC (it arrives as USDC.e) and, in a second bridge, PathUSD; set the recipient to the treasury address. Relay's API lists USDC.e, PathUSD, OUSD and USDT0 as bridgeable to Tempo (checked 2026-10-07: `curl -s https://api.relay.link/chains`).
- **Stargate** (<https://stargate.finance>): USDC to USDC.e on Tempo, with no Stargate fee on the Ethereum route (other routes have one). USDC.e only.
- **Tempo Wallet** (<https://wallet.tempo.xyz>, a passkey wallet): add funds by card on-ramp or bridge, then send to the treasury.
- Also listed by Tempo: Across, Squid, Bungee, Chainlink CCIP.

Send a dollar first and check it arrives. Never send from an exchange or a network that does not support Tempo. The treasury page shows both balances (Balance in USDC.e, Fee balance in pathUSD).

## 8. The first real pay run (checklist)

Before:

- [ ] `curl -s https://app.rolepay.app/health` answers `"network":"mainnet"`.
- [ ] Treasury page: USDC.e at least the run's total, pathUSD at least 0.5, the key Active with enough left, its expiry date noted.
- [ ] A one-dollar rehearsal: register yourself (`/payee link`, create a passkey), `/rolepay new amount:1 users:@you note:Rehearsal`, Approve, check the transaction, then send it on from <https://app.rolepay.app/account>. This proves the whole path with your own dollar.
- [ ] Each payee ran `/payee link` and created a passkey on app.rolepay.app (a synced passkey is best). Tell them their money is theirs alone: they see it and send it on at <https://app.rolepay.app/account> with the same passkey; sending costs about a cent, taken from what they send.

The run:

- [ ] `/rolepay new amount:<per person> users:@a @b note:<what it is for>` (`@b=<amount>` gives one person a different amount). Read the review: each line's amount, the short address, the total.
- [ ] **Approve.** Expect "Paid" within seconds and a View transaction link on explore.tempo.xyz: one transaction from the treasury, one `TransferWithMemo` per person, the fee in pathUSD.
- [ ] Each payee gets a DM receipt with the transaction and a **Your account** button.
- [ ] `/rolepay status` shows the key's remaining budget; `/rolepay export` sends the CSV for your records.

If a run fails, the message says what the chain shows and whether Retry is safe (it always waits until the last attempt can no longer land and checks the chain first). Never cancel and recreate a run whose message says "Do not retry": look at the explorer first.

| What you see | What it means | What to do |
| --- | --- | --- |
| refused the transaction (`insufficient_balance`) | the treasury lacks USDC.e for the payouts, or pathUSD for the fee | fund it (step 7), then Retry |
| needs X but the bot key has Y left, or `spending_limit_exceeded` | the payout limit or the fee budget is used up for this period | treasury page: replace the key with new limits (one prompt; the old key is revoked in the same transaction), then Retry |
| the key has expired, or `key_expired` | the 14 days are over | treasury page: authorise a new key |
| "This interaction failed" in Discord | the server did not answer in 3 seconds | `fly status -a rolepay-app`, `fly logs -a rolepay-app` |

## 9. How to stop everything

From fastest to slowest:

1. **Revoke the bot key** (the real stop, on chain): `/rolepay setup`, open the treasury page, sign in with the treasury passkey, **Revoke the bot key**. From then on the bot cannot move anything, whatever happens to the server. Every key still live on chain is listed with its own Revoke button.
2. **Pause standing policies**, if any: `/rolepay policy pause policy:<name>` for each (or on the dashboard). Revoking the key already holds every policy run.
3. **Scale to zero:** `fly scale count 0 -a rolepay-app`. Discord commands then fail; the volume keeps the database. Back with `fly scale count 1 -a rolepay-app`.
4. **Take the money back:** the treasury is your passkey's account, so sign in at <https://app.rolepay.app/account> with the treasury passkey and send the USDC.e and pathUSD wherever you like (the fee comes out of the token sent; Max leaves 0.1 for it).
5. If a secret leaked: Developer Portal, Bot, Reset Token, then `read -rs "BOT_TOKEN?Bot token: "; printf 'DISCORD_BOT_TOKEN=%s\n' "$BOT_TOKEN" | fly secrets import -a rolepay-app; unset BOT_TOKEN` (restarts the machine).

Logs and state: `fly logs -a rolepay-app`, `fly status -a rolepay-app`, `fly ssh console -a rolepay-app` (the database is `/data/rolepay.db`), `fly volumes snapshots list rolepay_app_data -a rolepay-app` (daily, five days kept). Redeploy after a change: `fly deploy -c fly.app.toml --local-only --ha=false` (about 20 seconds without answers; the boot sweep finishes any payment in flight, nothing is paid twice).

## What is different from the testnet demo

- **No sponsor and no faucet.** New communities start in fee budget mode with pathUSD, `/rolepay setup fees:sponsor` is refused, and the treasury page has no "Get testnet funds" button. Config refuses a mainnet server without `ROLEPAY_PAYOUT_TOKEN`, without `ROLEPAY_FEE_TOKEN` (when no sponsor is configured), with a fee token equal to the payout token, with a non-https `PUBLIC_URL`, or with the dev shortcuts or demo controls on.
- **Its own passkey domain** (`app.rolepay.app`): passkeys from the demo never work here, and the reverse.
- **Explorer links** go to explore.tempo.xyz (checked: `/tx/<hash>` and `/address/<address>` resolve).
- **Reconciliation** reads the memo events in windows of 10,000 blocks; the public mainnet RPC answered 50,000-block log queries and makes a block about every 0.6 seconds (checked 2026-10-07), so a run's 120-second deadline is about 200 blocks.

## Risks accepted for the pilot

- **The setup page's code comes from the bot server.** The page builds what the passkey signs from the form and refuses to sign if the server's copy differs, but a fully compromised server could serve different JavaScript and ask the passkey to sign something else. Accepted for a small pilot because the loss is bounded by the treasury (US$20 to 50); on the roadmap: serve the setup page as an immutable bundle from a separate static origin the bot server cannot change.
- **The treasury passkey is the only key to the treasury.** Use a synced passkey; keep the treasury small.
- **The database holds the passkeys' public keys** (a returning sign-in needs them) and the sealed bot key. Fly snapshots the volume daily; a lost database means re-authorising a key, and a browser that has forgotten the treasury account could not sign until the public key is recovered. Keep using the browser you set up with.
- **One machine in one region** (`iad`); a deploy or a crash means about 20 seconds without answers, and the recovery sweep finishes anything in flight.
- **Requests are rate limited in memory per process**, and bodies over 1 MB are refused.
- **Four eyes is off** (`requireSeparateApprover`): with one treasurer, the creator of a run may approve it. `/rolepay setup separate_approver:true` turns it on.
