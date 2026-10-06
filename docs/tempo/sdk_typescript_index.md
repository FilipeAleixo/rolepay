# TypeScript SDKs: Viem extension and Account SDK

Tempo distributes TypeScript SDKs for:

* [Viem](https://viem.sh): TypeScript interface for EVM blockchains
* [Wagmi](https://wagmi.sh): React Hooks (and reactive primitives) for EVM blockchains

The Tempo extensions cover common chain operations such as querying state, sending Tempo Transactions, and managing tokens and AMM pools.

* [Viem Setup](https://viem.sh/tempo) — Set up a Viem client to interact with Tempo
* [Wagmi Setup](https://wagmi.sh/tempo) — Set up a Wagmi configuration with Tempo

:::tip
**When should I use Wagmi vs. Viem?**

* **Viem** is best suited for **libraries, tooling, servers, scripting, etc** – a low-level and stateless interface for the EVM
* **Wagmi** is best suited for **applications & wallets** – a high-level and stateful interface for the EVM (React Hooks, Vanilla JS, etc)
:::

## Viem SDK for Tempo

Use Viem for Node.js scripts, servers, and other headless applications.

### Connect to Tempo Testnet and send a stablecoin

Install Viem:

```bash
npm install viem
```

Connect to Tempo Testnet, fund an account, read its OUSD balance, and send a confirmed transfer.

```ts twoslash [testnet.ts] filename="testnet.ts"
import { Account, createClient } from 'viem/tempo'

const privateKey = '0x...'
const account = Account.fromSecp256k1(privateKey)
const client = createClient({ account, testnet: true })

await client.faucet.fundSync({ account })

const token = '0x20c0000000000000000000006a37da5c996874be' // OUSD
const balance = await client.token.getBalance({ token })

const { receipt } = await client.token.transferSync({
  amount: { formatted: '1' },
  to: '0x742d35cc6634c0532925a3b844bc9e7595f0bebb',
  token,
})
```

:::warning
This example is testnet-only. For mainnet, use a funded mainnet account and token, omit `testnet: true`, and remove the faucet call.
:::

`balance` includes the amount in base units, the token's decimals, and a formatted value. `transferSync` waits for the transaction to be included; `receipt.transactionHash` identifies the transaction.

The same client includes standard Viem methods such as `getBlockNumber`, `getTransaction`, `getTransactionReceipt`, `getLogs`, `readContract`, and `simulateContract`.

### Tempo Transactions

| Goal | Viem input | Guide |
| --- | --- | --- |
| Send multiple calls together | `calls` | [Batch calls](https://tempo.xyz/developers/docs/guide/tempo-transaction#batch-calls) |
| Pay fees with a chosen token | `feeToken` | [Configurable fee tokens](https://tempo.xyz/developers/docs/guide/tempo-transaction#configurable-fee-tokens) |
| Let another account pay the fees | `feePayer` | [Fee sponsorship](https://tempo.xyz/developers/docs/guide/tempo-transaction#fee-sponsorship) |
| Send independent transaction sequences | `nonceKey` | [Concurrent transactions](https://tempo.xyz/developers/docs/guide/tempo-transaction#concurrent-transactions) |
| Limit when a transaction can run | `validAfter` and `validBefore` | [Scheduled transactions](https://tempo.xyz/developers/docs/guide/tempo-transaction#scheduled-transactions) |

### Tempo guides and API reference

* [Payments](https://tempo.xyz/developers/docs/guide/payments) — Send and accept stablecoins, attach memos, and configure payment controls
* [Stablecoin Issuance](https://tempo.xyz/developers/docs/guide/issuance) — Launch and operate a TIP-20 stablecoin
* [Stablecoin Exchange](https://tempo.xyz/developers/docs/guide/stablecoin-dex) — Trade stablecoins and provide liquidity
* [Tempo Transactions](https://tempo.xyz/developers/docs/guide/tempo-transaction) — Use fee tokens, sponsorship, batching, access keys, and concurrent transactions
* [Actions](https://viem.sh/tempo/actions) — Viem Actions for querying data, sending transactions, managing tokens & AMM pools, and more

## Wagmi SDK for Tempo

* [Hooks](https://wagmi.sh/tempo/hooks) — Wagmi React Hooks for building apps on Tempo
* [Connectors](https://wagmi.sh/tempo/connectors) — Wagmi Connectors for connecting between wallets, apps, and Tempo
* [Actions](https://wagmi.sh/tempo/actions) — Wagmi Actions for querying data, sending transactions, managing tokens & AMM pools, and more
