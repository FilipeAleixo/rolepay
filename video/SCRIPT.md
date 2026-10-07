# Rolepay films: the script

Two films for Colosseum's Crypto World's Fair (Tempo track), built in Remotion:

- **PitchVideo**, planned 2:30: you on camera, with the animated scenes cut in.
- **DemoVideo**, planned 2:44 (limit 3:00): screen recordings of the live product, captioned, with the explainer scenes between them.

Everything animated is done. What is left is your recordings: drop each file into `video/assets/` under the name below and it takes its slot.

## Open, preview, render

```bash
cd video
npm install                      # once; video/ is outside the pnpm workspace on purpose
npx remotion studio              # the studio opens in the browser (Films, Scenes, Overlays)
npx remotion render PitchVideo out/pitch.mp4
npx remotion render DemoVideo out/demo.mp4
npx remotion render TrustModel out/trust-model.mp4   # any single scene, to cut in elsewhere
npx remotion still Title out/title.png --frame=100
```

`video/assets/` and `video/out/` are gitignored: recordings and renders never go into git.

## How a slot works

- **A missing file shows a card** with what goes there (CAMERA or SCREEN RECORDING, the file name, the planned length and a progress line), so you can rehearse against the timeline before recording anything.
- **A file that exists plays, at its real length.** The slot stretches or shrinks to the clip, and the film's length follows. The studio shows a warning in the corner if the clips push a film past 3:00. Trim each recording to about its planned length.
- **Camera clips** fill the frame and play their sound. **Screen recordings** are fitted whole on the dark ground and play silent (except `pitch-2-demo.mp4`, which keeps its sound in case you narrate it).
- **Captions** in the demo are timed in seconds from the start of their clip. The click script below is timed to them. If a recording runs differently, change the `at` and `until` numbers in `src/timeline/demo.ts`.
- **Voice-overs for the pitch's scenes** are optional: record `pitch-vo-trust-model.m4a` (or `.mp3`, `.wav`) and it plays over that scene; a longer voice-over holds the scene's last frame until you finish. The scenes are written to read silent too.
- **A sound bed** is optional and off: a file named `pitch-audio.mp3` or `demo-audio.mp3` in `video/assets/` plays quietly under the whole film. Leave it out for no music.

## Recording setup

**Camera (pitch):** 1920 by 1080 or 4K, 30 fps, landscape. Sit a little left of centre: the right third carries short text panels in the "why me", "business" and "go-to-market" slots, and the lower left carries your name in the first slot. A plain, dim background suits the dark films. Record each slot as its own take and name the file after the slot.

**Screen (demo):** record at 1920 by 1080 (a 16:9 window or region), 30 fps, no sound needed. Discord in its dark theme, zoomed to 110 or 125% so text reads on a phone. Turn on Do Not Disturb, close other servers' notifications, and keep real people's private details off screen (use the demo server and your test accounts). Cut the waits (passkey prompts, the minute of a veto window) in any editor before dropping the file in.

**Names on screen:** "Pay the author" and "Draft pay run with AI" are the message commands on the `feat/discord-ux` branch. On `main` the AI command is still called "Propose pay run" and "Pay the author" does not exist yet. Record on a build that has `feat/discord-ux`, or change the captions in `src/timeline/demo.ts`.

## The pitch (PitchVideo)

| Starts | Item | File | Length |
| --- | --- | --- | --- |
| 0:00 | Title scene | | 4 s |
| 0:04 | Camera: the problem (your name appears) | `pitch-1-problem.mp4` | about 17 s |
| 0:20 | Scene: the problem | voice-over `pitch-vo-problem` optional | 8.5 s |
| 0:28 | Screen: the demo, short | `pitch-2-demo.mp4` | about 20 s |
| 0:48 | Camera: why Tempo | `pitch-3-why-tempo.mp4` | about 8 s |
| 0:56 | Scene: the trust model | voice-over `pitch-vo-trust-model` recommended | 20 s |
| 1:15 | Scene: why Tempo | voice-over `pitch-vo-why-tempo` optional | 8 s |
| 1:23 | Camera: why me (the two wins appear on the right) | `pitch-4-why-me.mp4` | about 14 s |
| 1:37 | Camera: business (two points on the right) | `pitch-5-business.mp4` | about 12 s |
| 1:48 | Scene: architecture | voice-over `pitch-vo-architecture` optional | 8 s |
| 1:56 | Camera: go-to-market (three points on the right) | `pitch-6-go-to-market.mp4` | about 10 s |
| 2:06 | Camera: honest status | `pitch-7-status.mp4` | about 13 s |
| 2:18 | Scene: by the numbers | voice-over `pitch-vo-numbers` optional | 7 s |
| 2:25 | End card | | 5 s, ends 2:30 |

Talking points, in your own words. Each is what the slot has to land, not a line to read.

**1. The problem** (`pitch-1-problem.mp4`, about 17 s; "Filipe Aleixo, Founder" shows for the first 5 s)
- Who you are, in one breath, and that you are building Rolepay.
- One community's words: how it pays its moderators, staff and bounty winners today. A real quote works best; name the community only if they agreed.
- The mechanics: one wallet send at a time, a spreadsheet, recipients who need gas, no clean record.
- Land on the risk: whoever holds the keys holds all the money.

**Scene: the problem** (8.5 s). Silent works, since it restates the point in three beats. A voice-over, if any: just the last beat, the keys.

**2. The demo, short** (`pitch-2-demo.mp4`, about 20 s, screen with sound). A cut of `demo-2-payrun.mp4`: `/rolepay new`, Approve, Paid, the DM receipt. Its captions are timed like the demo's first three: the run at 0.5 s, the approval at 7 s, the receipt at 13.5 s. Narrate over it or leave it silent.
- One command, one tap, one transaction, and everyone gets a receipt.

**3. Why Tempo** (`pitch-3-why-tempo.mp4`, about 8 s)
- The money stays in the community's own account; the bot only holds a key the chain itself limits.
- Hand over to the picture ("here is the whole model").

**Scene: the trust model** (20 s; voice-over recommended, `pitch-vo-trust-model`)
- 0 to 4 s: the treasury is the community's own Tempo account, and its root key is the treasurer's passkey.
- 3 to 8 s: the bot gets an access key, nothing more: it expires, it has a budget per period, and it can only make memo'd transfers of one token.
- 8 to 11 s: a batch inside the budget pays everyone in one transaction.
- 11 to 15 s: a batch over what is left is refused whole, by the chain, even with Rolepay's own checks switched off (shown on the testnet).
- 16 to 20 s: so the worst case for a compromised bot is one period's budget.

**Scene: why Tempo** (8 s; voice-over optional): access keys with limits per period, even inside batches; passkey accounts; memos on stablecoin transfers; fee sponsorship, so recipients need no gas.

**4. Why me** (`pitch-4-why-me.mp4`, about 14 s; from 2 s the right side shows "Hackathon wins, 2021": Gitcoin, `discord-ethereum-authentication`; ETHOnline, Enzyme, 2nd place, `discord-dao-treasury-management`)
- You have been building at this intersection, Discord plus on-chain money, since 2021.
- What each project did, in a phrase.
- Why now: Tempo's access keys make the safe version of that idea possible.

**5. Business** (`pitch-5-business.mp4`, about 12 s; from 2 s: "An open-source core", "A hosted bot per community")
- The core is open source (MIT): anyone can audit it or run their own.
- The business is the hosted bot, one per community. Say what they pay for (hosting, upkeep, support); give prices only if decided.

**Scene: architecture** (8 s; voice-over optional): one core with ports and adapters; Discord and the web pages are thin adapters over its services; the server wires it together; Tempo underneath. That is what lets the same code be open source and hosted.

**6. Go-to-market** (`pitch-6-go-to-market.mp4`, about 10 s; from 1.5 s: "Crypto communities first", "Then creator communities", "Then gaming")
- Crypto communities first: they already hold stablecoins and already pay contributors.
- Then creator communities, then gaming (staff, tournaments, guild payouts).
- How you reach the first ones.

**7. Honest status** (`pitch-7-status.mp4`, about 13 s)
- What works today on the testnet demo: pay runs, AI proposals, standing policies, the dashboard, the judge flow.
- What is proven on chain: the over-limit batch, the out-of-scope call and the revoked key, each refused.
- Mainnet: say exactly where the pilot stands on the day.
- What is not done yet, specifically (the threat model's open items are a good source).

**Scene: by the numbers** (7 s): 1,395 tests, line coverage per package, 3 chain proofs, $0.003 per AI proposal. Silent is fine.

**End card** (5 s): rolepay.app, the repository, "Built for Colosseum's Crypto World's Fair, Tempo track".

## The demo (DemoVideo)

| Starts | Item | File | Length |
| --- | --- | --- | --- |
| 0:00 | Title scene | | 4 s |
| 0:04 | Setup and the treasury passkey | `demo-1-setup.mp4` | about 18 s |
| 0:21 | Scene: the trust model (what that key can do) | | 20 s |
| 0:41 | A pay run, approved and paid | `demo-2-payrun.mp4` | about 21 s |
| 1:02 | Scene: never pays twice | | 7 s |
| 1:08 | Pay the author | `demo-3-pay-author.mp4` | about 12 s |
| 1:20 | Scene: AI writes the rule once... | | 10 s |
| 1:30 | A policy on autopilot | `demo-4-policy.mp4` | about 21 s |
| 1:50 | An AI proposal | `demo-5-ai-proposal.mp4` | about 16 s |
| 2:06 | The dashboard | `demo-6-dashboard.mp4` | about 17 s |
| 2:23 | The judge flow | `demo-7-judge.mp4` | about 17 s |
| 2:39 | End card | | 5 s, ends 2:44 |

What to click, timed to each caption (seconds from the start of the clip).

**demo-1-setup.mp4** (about 18 s). Record on a fresh test server: the public demo's treasury already exists.
- 0 to 5.5 s, caption "`/rolepay setup` names the approver role": type `/rolepay setup approver_role:@Treasurer`; the ephemeral setup card appears with its **Treasury page** link.
- 6 to 11.5 s, "The treasurer creates the *treasury* with a passkey": open the link, press **Create the treasury passkey**, confirm with your fingerprint; "Signed in as the treasury"; press **Get testnet funds**.
- 12 to 17.5 s, "The bot gets an *access key*: an expiry, a limit, one call": keep 100 AlphaUSD, every 30 days, expires after 30 days; press **Authorise the bot key with my passkey**, confirm; "The bot key is active".

**demo-2-payrun.mp4** (about 21 s). Two registered payees with the Mods role.
- 0 to 5.5 s, "`/rolepay new` builds a run for a *role*": `/rolepay new amount:1 role:@Mods`; the public "Pay run awaiting approval" review.
- 6 to 10.5 s, "The treasurer *approves* with one button": click **Approve**; "Approved, paying...", then "Paid".
- 11 to 15.5 s, "Paid in *one batched transaction*, one memo per line": click **View transaction**; on the explorer, one transaction with a `TransferWithMemo` per line.
- 16 to 20.5 s, "Every payee gets a *DM receipt*": open a payee's DMs; the receipt with the amount and the transaction link.

**demo-3-pay-author.mp4** (about 12 s)
- 0 to 5.5 s, "Right-click a message, Apps, *Pay the author*": right-click a registered member's helpful message, Apps, **Pay the author**; the form with the amount and the note (prefilled "For this message").
- 6 to 11.5 s, "A one-line run for its author, still *approved* by a human": submit; the one-line review is posted with **Approve**.

**demo-4-policy.mp4** (about 21 s). Needs the demo controls (one-minute veto windows, `run_now`).
- 0 to 5.5 s, "A standing rule in plain words: `/rolepay policy new`": in the channel where its runs should post, `/rolepay policy new instruction:1 per answered question in #help, max 50 a week each, for Mods schedule:Weekly weekday:Monday hour:18 name:Help desk`; "Policy draft: Help desk" appears.
- 6 to 10.5 s, "It shows *who it applies to* before anyone approves": scroll the preview's "who it applies to right now"; press **Approve policy**.
- 11 to 15.5 s, "On autopilot, each run is posted with a *veto window*": `/rolepay policy mode policy:Help desk mode:Autopilot veto_minutes:1`, then `/rolepay policy run_now policy:Help desk`; the run appears with "pays at ... unless vetoed" and **Veto**.
- 16 to 20.5 s, "Then it pays itself, inside the key's *on-chain limit*": cut the minute; the same message turns into "Paid" with the transaction.

**demo-5-ai-proposal.mp4** (about 16 s). For a held line that shows reliably, have your second account post the winners message naming itself and you ("Winners: @second (docs), @you (claim page bug)"): its own line then rests only on its own message.
- 0 to 5 s, "Right-click the winners post: *Draft pay run with AI*": right-click that message, Apps, **Draft pay run with AI**, type `50 each, the docs one 20`, submit; "Reading the message and drafting a proposal…".
- 5.5 to 10.5 s, "A line backed only by *their own message* is held": the proposal; point the cursor at "Left out (shown, not in the run)" and "their own message is the only source".
- 11 to 15.5 s, "The footer shows what it cost: *under half a cent*": the footer "Drafted by Sonnet 5.5 · 2.1 s · $0.004" (your numbers will differ); optionally press **Create pay run**.

**demo-6-dashboard.mp4** (about 17 s). Signed in already (cut the Discord sign-in).
- 0 to 5.5 s, "The dashboard: *At a glance*, the key's budget and its limit": the Overview, the "At a glance" panel, the budget bar with its hard end line.
- 6 to 11 s, "What was paid each week, by policy and by hand": the weekly chart beside it.
- 11.5 to 16.5 s, "Every step in the *audit log*, exportable to CSV": **Audit log**, a filter, **Export CSV**.

**demo-7-judge.mp4** (about 17 s). As a judge would, on the public demo with a fresh account.
- 0 to 5.5 s, "Judges join the demo server and run `/payee link`": `#start-here`, the pinned welcome post, `/payee link`, the ephemeral link.
- 6 to 11 s, "Create a passkey, react to the welcome post": open the link, **Create my passkey**, confirm; back in Discord, react ✅ to the welcome post.
- 11.5 to 16.5 s, "Paid at the next daily run, *with nobody online*": `#payouts` at 18:00 UTC (a recording of an earlier day is fine): the run with "pays at ... unless vetoed", then "Paid"; the DM receipt.

## Before the final render

- **The numbers** in `src/data/numbers.ts` were measured on `main` at 8bf685e: 1,395 tests (core 699, discord 356, web 208, server 132) and line coverage core 94.97%, discord 96.59%, web 86.23%, server 85.92%. The README still says 1,380 tests, web 85.12% and server 85.6%: update one so they match, and re-run `pnpm test` if more code lands.
- **The cost**: the numbers scene says $0.003 per proposal and the AI scene's card shows $0.004 in its footer; the README's range is $0.003 to $0.004 with the prompt cache warm.
- **Length**: open each film in the studio with every clip in place and check the duration (the corner warning appears past 3:00).
