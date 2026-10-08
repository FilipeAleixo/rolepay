# Rolepay films: the script

Two films for Colosseum's Crypto World's Fair (Tempo track), built in Remotion:

- **PitchVideo**, planned 2:34 (limit 3:00): you on camera, with the animated scenes cut in.
- **DemoVideo**, planned 2:56 (hard limit 3:00): screen recordings of the live product, captioned, with the explainer scenes between them.

Everything animated is done. What is left is your recordings: drop each file into `video/assets/` under the name below and it takes its slot. Do the four steps under "Before recording" first: two of them take a while and one of them changes what the judges' daily run signs with.

## Open, preview, render

```bash
cd video
npm install                      # once; video/ is outside the pnpm workspace on purpose
npx remotion studio              # the studio opens in the browser (Films, Scenes, Overlays)
npm run stills                   # one still of every scene into out/stills/, for a quick review
npx remotion render PitchVideo out/pitch.mp4
npx remotion render DemoVideo out/demo.mp4
npx remotion render OwnBudgets out/own-budgets.mp4   # any single scene, to cut in elsewhere
```

`video/assets/` and `video/out/` are gitignored: recordings and renders never go into git.

## How a slot works

- **A missing file shows a card** with what goes there (CAMERA or SCREEN RECORDING, the file name, the planned length and a progress line), so you can rehearse against the timeline before recording anything.
- **A file that exists plays, at its real length.** The slot stretches or shrinks to the clip, and the film's length follows. The studio shows a warning in the corner if the clips push a film past 3:00.
- **The demo is tight.** It is planned 3.8 s under the limit, so trim every recording to its planned length. If one runs long, take the time out of another. If you still need room, take `neverPayTwice` out of `src/timeline/demo.ts` (that gives back 6.2 s).
- **Camera clips** fill the frame and play their sound. **Screen recordings** are fitted whole on the dark ground and play silent (except `pitch-2-demo.mp4`, which keeps its sound in case you narrate it).
- **Captions** in the demo are timed in seconds from the start of their clip. The click script below is timed to them. If a recording runs differently, change the `at` and `until` numbers in `src/timeline/demo.ts`.
- **Voice-overs for the pitch's scenes** are optional: record `pitch-vo-trust-model.m4a` (or `.mp3`, `.wav`) and it plays over that scene; a longer voice-over holds the scene's last frame until you finish. The scenes are written to read silent too. The names: `pitch-vo-problem`, `pitch-vo-trust-model`, `pitch-vo-own-budgets`, `pitch-vo-why-tempo`, `pitch-vo-architecture`, `pitch-vo-numbers`.
- **A sound bed** is optional and off: a file named `pitch-audio.mp3` or `demo-audio.mp3` in `video/assets/` plays quietly under the whole film. Leave it out for no music.

## Before recording (on the demo, in this order)

Everything here is on `https://demo.rolepay.app` and its Discord server, from the device that holds the treasury passkey, as the `Treasurer`.

1. **Deposit addresses, set up first** (it can take 20 seconds or several minutes, so never on camera).
   - `/rolepay setup`, open the **Treasury page** link, sign in with the treasury passkey if it asks.
   - Step **4. Deposit addresses**: press **Set up deposit addresses**. Use a desktop browser and keep the tab in front: the status counts the tries while the browser looks for a registration code (about a minute and a half on average, sometimes 20 seconds, sometimes several minutes). Then one passkey prompt, and "Deposit addresses are set up". It is permanent.
   - Do not create the funding sources yet: `demo-8-funding.mp4` records `/rolepay fund new`, and a name already in use is refused. To rehearse, use a throwaway name.
2. **Preferred stablecoins on, and the bot key replaced, both together.**
   - On the same treasury page, step 3: tick **Pay each person in the stablecoin they prefer**. Nothing changes on chain yet; the page says the current bot key cannot swap.
   - Right away, press **Replace the bot key with these limits** and confirm: one passkey prompt, and the page says "On: people who chose another stablecoin get it".
   - Never leave the switch on with the old key: every run that pays someone who chose another stablecoin is then held (`swap_not_authorized`), the judges' daily run included.
   - The new key's limit and expiry replace the old one's. Keep a limit that covers the takes and the judges you expect, and an expiry past the end of judging (the form's default is 30 days).
3. **The Judges policy with its own budget**, after step 2, so its key carries the swap scope too.
   - `/rolepay policy show policy:Judges` (with `Treasurer`): the private answer has **Give this policy its own budget**. Or the dashboard: Policies, Judges, Budget.
   - On "A budget of its own for Judges": **Spend limit** `30` (the judges you expect per day), **Resets every** `1` day, **Key expires after** the days until judging ends (for example `14`). Press **Give this policy its own budget**: one passkey prompt, "Judges has its own budget now".
   - Record this step: it is the first half of `demo-6-policy-budget.mp4`. If it is already done, record the same page replacing the key with the same numbers (the button then reads **Replace this policy's key with these limits**, still one prompt).
   - If the Judges policy got its own budget before step 2, replace its key now anyway. A policy key from before the switch cannot swap, so the judges' runs that pay someone in another stablecoin would be held.
   - Check: `/rolepay policy show policy:Judges` says `Own budget: 30 of 30 AlphaUSD left this period (chain-enforced)`.
4. **A second Discord account set to prefer BetaUSD.**
   - From your second account (a registered payee with the `Mods` role): `/payee prefer token:BetaUSD`. After step 2 the private reply says "You will be paid in BetaUSD. Each run swaps AlphaUSD into it on Tempo's stablecoin exchange, in the same transaction that pays you".
   - The take for `demo-4-preferred.mp4` runs the same command again; the answer is the same.

Also check before the session:

- `/payee prefer` and `/rolepay fund` show in Discord. If not, register the commands again as in `apps/server/README.md`, "Deploying" (demo controls on, dev shortcuts off).
- The treasury has AlphaUSD (the setup page's **Get testnet funds**), and the bot key has room for the takes (`/rolepay setup` shows what is left).
- A second browser profile signed in at `https://demo.rolepay.app/account` with your second account's passkey, holding some AlphaUSD (for example what the Judges policy paid it), to send the deposit in `demo-8-funding.mp4`.
- The Judges policy is approved and on autopilot, and the welcome post is pinned in `#start-here` (as it is now).

## Recording setup

**Camera (pitch):** 1920 by 1080 or 4K, 30 fps, landscape. Sit a little left of centre: the right third carries short text panels in the "why Tempo", "why me", "business" and "go-to-market" slots, and the lower left carries your name in the first slot. A plain, dim background suits the dark films. Record each slot as its own take and name the file after the slot.

**Screen (demo):** record at 1920 by 1080 (a 16:9 window or region), 30 fps, no sound needed. Discord in its dark theme, zoomed to 110 or 125% so text reads on a phone. Turn on Do Not Disturb, close other servers' notifications, and keep real people's private details off screen (use the demo server and your test accounts). In `#payouts`, a run lists the judges it paid: record a day that paid only your test accounts, or blur the names. Cut the waits (passkey prompts, the AI's few seconds, the minute of a veto window, the deposit watcher's up to 30 seconds) in any editor before dropping the file in.

**Names on screen:** "Pay the author", "Draft pay run with AI" and "Pay with Rolepay" are on `main`, so any current deploy shows them as the captions say.

## The pitch (PitchVideo)

The frame for the whole pitch: **access keys are how you give software a budget it can't exceed.** Rolepay gives one to a community's bot, and one to each of its standing policies, all authorised by the treasurer's passkey.

| Starts | Item | File | Length |
| --- | --- | --- | --- |
| 0:00 | Title scene | | 4 s |
| 0:04 | Camera: the opening and the problem (your name appears) | `pitch-1-problem.mp4` | about 15 s |
| 0:18 | Scene: the problem | voice-over `pitch-vo-problem` optional | 8.5 s |
| 0:26 | Screen: the demo, short | `pitch-2-demo.mp4` | about 16 s |
| 0:42 | Camera: why Tempo (three points on the right) | `pitch-3-why-tempo.mp4` | about 9 s |
| 0:51 | Scene: the trust model | voice-over `pitch-vo-trust-model` recommended | 20 s |
| 1:10 | Scene: its own on-chain budget | voice-over `pitch-vo-own-budgets` optional | 12 s |
| 1:22 | Scene: why Tempo | voice-over `pitch-vo-why-tempo` optional | 10 s |
| 1:32 | Camera: why me (the two wins on the right) | `pitch-4-why-me.mp4` | about 12 s |
| 1:43 | Camera: business (two points on the right) | `pitch-5-business.mp4` | about 10 s |
| 1:53 | Scene: architecture | voice-over `pitch-vo-architecture` optional | 8 s |
| 2:01 | Camera: go-to-market (three points on the right) | `pitch-6-go-to-market.mp4` | about 9 s |
| 2:09 | Camera: honest status | `pitch-7-status.mp4` | about 12 s |
| 2:21 | Scene: by the numbers | voice-over `pitch-vo-numbers` optional | 8 s |
| 2:29 | End card | | 5 s, ends 2:34 |

Talking points, in your own words. Each is what the slot has to land, not a line to read.

**1. The opening and the problem** (`pitch-1-problem.mp4`, about 15 s; "Filipe Aleixo, Founder" shows for the first 5 s)
- Open on the frame, in your words: access keys are how you give software a budget it can't exceed; Rolepay hands one to a community's treasurer, and one to each of its standing policies.
- On the mechanics, so it stays exact: the treasurer's passkey is the root of the treasury and authorises each key; the bot holds the community's key, and each standing policy can hold its own.
- Who you are, in one breath, and that you are building Rolepay.
- One community's words: how it pays its moderators, staff and bounty winners today. A real quote works best; name the community only if they agreed.
- Land on the risk: whoever holds the keys holds all the money. (The scene right after lists the mechanics of today, so you can skip them here.)

**Scene: the problem** (8.5 s). Silent works, since it restates the point in three beats. A voice-over, if any: just the last beat, the keys.

**2. The demo, short** (`pitch-2-demo.mp4`, about 16 s, screen with sound). A cut of `demo-2-payrun.mp4`: `/rolepay new`, Approve, Paid, the DM receipt. Its captions: the run at 0.5 s, the approval at 6 s, the receipt at 11 s. Narrate over it or leave it silent.
- One command, one tap, one transaction, and everyone gets a receipt.

**3. Why Tempo** (`pitch-3-why-tempo.mp4`, about 9 s; from 1.5 s the right side shows "Access keys": "A budget software can't exceed", "One for the bot, one for each policy", "Authorised by the treasurer's passkey")
- Back to the opening frame, now concrete: the money stays in the community's own Tempo account; the bot holds only an access key, a budget the chain enforces.
- Each standing policy can hold its own, so one rule that goes wrong can spend only its own budget.
- Hand over to the picture ("here is the whole model").

**Scene: the trust model** (20 s; voice-over recommended, `pitch-vo-trust-model`)
- 0 to 4 s: the treasury is the community's own Tempo account, and its root key is the treasurer's passkey.
- 3 to 8 s: the bot gets an access key, nothing more: it expires, it has a budget per period, and it can only make memo'd transfers of one token.
- 8 to 11 s: a batch inside the budget pays everyone in one transaction.
- 11 to 15 s: a batch over what is left is refused whole, by the chain, even with Rolepay's own checks switched off (shown on the testnet).
- 16 to 20 s: so the worst case for a compromised bot is one period's budget.

**Scene: its own on-chain budget** (12 s; voice-over optional, `pitch-vo-own-budgets`)
- 0 to 3 s: the same treasury's passkey authorises a second key, for one standing policy, next to the bot key.
- 2.5 to 5 s: each key has its own limit, on chain.
- 5 to 8 s: the policy's batch over its own limit is refused whole by the chain, while the bot key still has room, and the bot key is never used for that policy.
- 9 to 12 s: every agent gets its own budget, and the chain enforces each one (shown on Moderato with Rolepay's checks skipped).

**Scene: why Tempo** (10 s; voice-over optional): access keys, many per account (a budget for the bot and one per policy, even inside batches); passkey accounts; memos on stablecoin transfers; fee sponsorship, so recipients need no gas; virtual addresses (a deposit address per funder, no sweep); the enshrined stablecoin DEX (paid in the stablecoin they choose, in the same batch).

**4. Why me** (`pitch-4-why-me.mp4`, about 12 s; from 1.5 s the right side shows "Hackathon wins, 2021": Gitcoin, `discord-ethereum-authentication`; ETHOnline, Enzyme, 2nd place, `discord-dao-treasury-management`)
- You have been building at this intersection, Discord plus on-chain money, since 2021.
- What each project did, in a phrase.
- Why now: Tempo's access keys make the safe version of that idea possible.

**5. Business** (`pitch-5-business.mp4`, about 10 s; from 1.5 s: "An open-source core", "A hosted bot per community")
- The core is open source (MIT): anyone can audit it or run their own.
- The business is the hosted bot, one per community. Say what they pay for (hosting, upkeep, support); give prices only if decided.

**Scene: architecture** (8 s; voice-over optional): one core with ports and adapters; Discord and the web pages are thin adapters over its services; the server wires it together; Tempo underneath. That is what lets the same code be open source and hosted.

**6. Go-to-market** (`pitch-6-go-to-market.mp4`, about 9 s; from 1.2 s: "Crypto communities first", "Then creator communities", "Then gaming")
- Crypto communities first: they already hold stablecoins and already pay contributors, and sponsors can fund them straight into the treasury with their own deposit address.
- Then creator communities, then gaming (staff, tournaments, guild payouts).
- How you reach the first ones.

**7. Honest status** (`pitch-7-status.mp4`, about 12 s)
- What works today on the testnet demo: pay runs, AI proposals, standing policies with their own budgets, payees paid in the stablecoin they choose, funding with attribution, the dashboard, the judge flow.
- What is proven on chain: ten proofs on Moderato, each linked in the README, among them the over-limit batch, the out-of-scope call, the revoked key, a policy key over its own limit, a swap over its cap and deposits attributed with no sweep.
- Mainnet: say exactly where the pilot stands on the day.
- What is not done yet, specifically. The threat model's open items: a lying RPC (T3, and the deposit watcher's reads, T29), the setup page's code served by the same server (T15), and which key signs a run being the server's decision, with every key in one vault (T24).

**Scene: by the numbers** (8 s): 1,734 tests, line coverage per package, 10 chain proofs (from 37 chain tests in 9 files), $0.003 per AI proposal. Silent is fine.

**End card** (5 s): demo.rolepay.app, the repository, "Built for Colosseum's Crypto World's Fair, Tempo track".

## The demo (DemoVideo)

| Starts | Item | File | Length |
| --- | --- | --- | --- |
| 0:00 | Title scene | | 4 s |
| 0:04 | Setup and the treasury passkey | `demo-1-setup.mp4` | about 12 s |
| 0:15 | Scene: the trust model (what that key can do) | | 20 s |
| 0:35 | A pay run, approved and paid | `demo-2-payrun.mp4` | about 13 s |
| 0:48 | Scene: never pays twice | | 6.5 s |
| 0:54 | Right-click a message: Pay the author, Draft pay run with AI | `demo-3-right-click.mp4` | about 15 s |
| 1:08 | Scene: the stablecoin they choose | | 10 s |
| 1:18 | The stablecoin they choose | `demo-4-preferred.mp4` | about 11 s |
| 1:29 | Scene: AI writes the rule once... | | 9 s |
| 1:37 | A policy on autopilot | `demo-5-policy.mp4` | about 13 s |
| 1:50 | The policy's own budget | `demo-6-policy-budget.mp4` | about 10 s |
| 2:00 | Scene: its own on-chain budget | | 12 s |
| 2:11 | The dashboard | `demo-7-dashboard.mp4` | about 9 s |
| 2:20 | Scene: funding with attribution | | 10 s |
| 2:30 | Funding | `demo-8-funding.mp4` | about 10 s |
| 2:39 | The judge flow | `demo-9-judge.mp4` | about 12 s |
| 2:51 | End card | | 5 s, ends 2:56 |

What to click, timed to each caption (seconds from the start of the clip).

**demo-1-setup.mp4** (about 12 s). Record on a fresh test server: the public demo's treasury already exists.
- 0.5 to 4 s, caption "`/rolepay setup` names the approver role": type `/rolepay setup approver_role:@Treasurer`; the ephemeral setup card appears with its **Treasury page** link.
- 4.5 to 8 s, "The treasurer creates the *treasury* with a passkey": open the link, press **Create the treasury passkey**, confirm with your fingerprint; "Signed in as the treasury"; press **Get testnet funds**.
- 8.5 to 11.5 s, "The bot gets an *access key*: an expiry, a limit, one call": keep 100 AlphaUSD, every 30 days, expires after 30 days; press **Authorise the bot key with my passkey**, confirm; "The bot key is active".

**demo-2-payrun.mp4** (about 13 s). Two registered payees with the Mods role. With step 4 done, the second account's line shows its swap, which is right but belongs to demo-4: for a plain run, set it back for this take (`/payee prefer token:AlphaUSD`, and `token:BetaUSD` again before demo-4), or record this take on the test server from demo-1.
- 0.5 to 4 s, "`/rolepay new` builds a run for a *role*": `/rolepay new amount:1 role:@Mods`; the public "Pay run awaiting approval" review.
- 4.5 to 8.5 s, "One tap to *approve*, one batched transaction": click **Approve**; "Approved, paying...", then "Paid"; click **View transaction**: on the explorer, one transaction with a `TransferWithMemo` per line.
- 9 to 12.5 s, "One memo per line, and a *DM receipt* for each payee": stay a moment on the memos, then open a payee's DMs: the receipt with the amount and the transaction link.

**demo-3-right-click.mp4** (about 15 s). AI proposals on. Beforehand, have your second account post the winners message naming itself and you ("Winners: @second (docs), @you (claim page bug)"), so its own line rests only on its own message and is held reliably.
- 0.5 to 4 s, "Right-click a message, Apps, *Pay the author*: a one-line run": right-click a registered member's helpful message, Apps, **Pay the author**; the form with the amount and the note (prefilled "For this message"); submit; the one-line review with **Approve**.
- 4.5 to 7.5 s, "Or *Draft pay run with AI* from a winners post": right-click the winners post, Apps, **Draft pay run with AI**, type `50 each, the docs one 20`, submit (cut the few seconds of drafting).
- 8 to 11 s, "A line backed only by *their own message* is held": the proposal; point the cursor at "Left out (shown, not in the run)" and "their own message is the only source".
- 11.5 to 14.5 s, "The footer shows what it cost: *under half a cent*": the footer "Drafted by Sonnet 5.5 · 2.1 s · $0.004" (your numbers will differ).

**demo-4-preferred.mp4** (about 11 s). On the demo server, after steps 2 and 4.
- 0.5 to 3.5 s, "A payee picks a stablecoin: `/payee prefer`": from the second account, `/payee prefer token:BetaUSD`; the private reply "You will be paid in BetaUSD...".
- 4 to 7 s, "The run shows the *swap* and the most it may spend": as yourself, `/rolepay new amount:5 users:@you @second note:Preferred stablecoins`; the review shows `@second  5 AlphaUSD → 5 BetaUSD (swapped)` and the **Swaps** field with the most the swap may spend (5.05 AlphaUSD).
- 7.5 to 10.5 s, "Paid in *BetaUSD*, in the same transaction": click **Approve**, then "Paid"; the second account's DM: "You were paid 5 BetaUSD", "In BetaUSD, the stablecoin you chose: swapped from AlphaUSD on Tempo's stablecoin exchange in the same transaction". If there is a second to spare, the explorer: the swap, then two `TransferWithMemo` events.

**demo-5-policy.mp4** (about 13 s). Needs the demo controls (one-minute veto windows, `run_now`), as on the demo.
- 0.5 to 4 s, "A standing rule in plain words: `/rolepay policy new`": in the channel where its runs should post, `/rolepay policy new instruction:1 per answered question in #help, max 50 a week each, for Mods schedule:Weekly weekday:Monday hour:18 name:Help desk`; "Policy draft: Help desk" appears.
- 4.5 to 8 s, "It shows *who it applies to* before anyone approves": scroll the preview's "who it applies to right now"; press **Approve policy**. (Discord then offers you, privately, "Give Help desk its own budget?": leave it, or cut it.)
- 8.5 to 12.5 s, "On autopilot: a *veto window*, then it pays itself": `/rolepay policy mode policy:Help desk mode:Autopilot veto_minutes:1`, then `/rolepay policy run_now policy:Help desk`; the run appears with "pays at ... unless vetoed" and **Veto** (record it in `#treasury`, where the Veto button is posted; the channel you ran it in shows the same run without the button); cut the minute; the same message turns into "Paid" with the transaction.

**demo-6-policy-budget.mp4** (about 10 s). This is step 3 of "Before recording", recorded.
- 0.5 to 4.5 s, "Give the Judges policy *its own budget*: one passkey prompt": `/rolepay policy show policy:Judges`, **Give this policy its own budget** (or **Manage its budget**); on "A budget of its own for Judges": 30, every 1 day, 14 days; "You will sign, for this policy only: Up to 30 AlphaUSD every day..."; press the button, confirm; "Judges has its own budget now".
- 5 to 9.5 s, "Its page draws that budget *from the chain*": the dashboard, Policies, Judges: the Budget card, "This policy's own budget", with its bar and the limit; or `/rolepay policy show policy:Judges`: "Own budget: 30 of 30 AlphaUSD left this period (chain-enforced)".

**demo-7-dashboard.mp4** (about 9 s). Signed in already (cut the Discord sign-in).
- 0.5 to 4.5 s, "The dashboard: *At a glance*, the key's budget and its limit": the Overview, the "At a glance" panel, the budget bar with its hard end line ("Funded this month" beside it is fine).
- 5 to 8.5 s, "Every step in the *audit log*, exportable to CSV": **Audit log**, a filter, **Export CSV**.

**demo-8-funding.mp4** (about 10 s). After step 1.
- 0.5 to 4.5 s, "`/rolepay fund new`: a *deposit address* for each source": in a channel, `/rolepay fund new name:Q4 bounty sponsor: Acme DAO`; the reply with the source's deposit address, **Funding page** and **On the explorer**. (`/rolepay fund new name:Judges pool` too, off camera, if you want two sources on the page.)
- 5 to 9.5 s, "A deposit lands in the treasury, *attributed* to its source": in the second browser profile, on `https://demo.rolepay.app/account`, send 0.5 AlphaUSD to that deposit address (cut it short); within 30 seconds the dashboard's **Funding** page lists the deposit under "Q4 bounty sponsor: Acme DAO", with the sender and the transaction, and "Funded this month" shows it. Never send from the treasury itself: the treasury paying its own deposit address is not a deposit, and Rolepay does not count it. (The faucet works too, but it mints 1,000,000 of each test stablecoin, so the page shows 3,000,000 USD.)

**demo-9-judge.mp4** (about 12 s). As a judge would, on the public demo with a fresh account.
- 0.5 to 4 s, "Judges join the demo server and run `/payee link`": `#start-here`, the pinned welcome post, `/payee link`, the ephemeral link.
- 4.5 to 7.5 s, "Create a passkey, react to the welcome post": open the link, **Create my passkey**, confirm; back in Discord, react ✅ to the welcome post.
- 8 to 11.5 s, "Paid at the next daily run, *with nobody online*": `#payouts` at 16:00 UTC (a recording of an earlier day is fine; the 2026-10-08 run, recorded at 15:00 UTC with the payee's account page beside it, shows the swap and the live count-up): the run with "pays at ... unless vetoed" (no button there: the Veto is in `#treasury`), then "Paid"; the DM receipt. Since step 3 the run is signed with the Judges policy's own key.

## Before the final render

- **The numbers** in `src/data/numbers.ts` are the ones measured on `main` at 9ceb17a and stated in the README: 1,734 tests (core 882, discord 416, web 292, server 144), line coverage core 95.72%, discord 96.91%, web 86.91%, server 85.78%, and `pnpm test:chain` at 37 tests in 9 files. The 10 chain proofs are the ones the README links on the explorer. Re-run `pnpm test` if more code lands.
- **The cost**: the numbers scene says $0.003 per proposal and the AI scene's card shows $0.004 in its footer; the README's range is $0.003 to $0.004 with the prompt cache warm.
- **Length**: open each film in the studio with every clip in place and check the duration (the corner warning appears past 3:00). The demo has 3.8 s to spare.
- **The stills**: `npm run stills` writes one frame of every scene to `out/stills/`.
