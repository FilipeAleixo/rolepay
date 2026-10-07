# Verify @rolepay/core by hand

About 5 minutes. From the repo root.

1. `pnpm install`, then `pnpm typecheck` and `pnpm test`. Expect every test green and no network calls.
2. `pnpm test:chain`. First run writes throwaway keys into the root `.env` (gitignored) and funds the treasury from the Moderato faucet. Expect 10 of 10 green in under a minute.
3. Open `.chain-results/rolepay.chain.json` and paste the `run-1` tx hash into `https://explore.testnet.tempo.xyz/tx/<hash>`. Check:
   - one transaction with three `TransferWithMemo` events (1.000001, 2.5 and 3.25 AlphaUSD to three fresh addresses);
   - the fee payer is the sponsor, not the treasury;
   - the `crash-recovery` tx is a separate run with two lines, paid once.
4. Optional: `git log --stat` shows `.env` was never committed (`git log --all -- .env` prints nothing).
