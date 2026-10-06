# Send parallel transactions using expiring nonces

Tempo enables concurrent transaction execution through its [expiring nonce](https://tempo.xyz/developers/docs/guide/tempo-transaction#expiring-nonces) system. Unlike traditional sequential nonces that require transactions to be processed one at a time, expiring nonces allow multiple transactions to be submitted simultaneously without nonce conflicts. Each transaction uses an independent nonce that automatically expires after a set time window, enabling true parallel execution.

## Parallel transaction demo

By the end of this guide you will understand how to send parallel payments using expiring nonces under-the-hood.

**Interactive demo: Send Parallel Payments**

1. Connect
2. Add funds
3. Send parallel payments

## Parallel transaction implementation steps

::::steps
### Set up Wagmi for parallel transactions

Ensure that you have set up your project with Wagmi, a Tempo chain config, and a wallet connector:

* [Connection details](https://tempo.xyz/developers/docs/quickstart/connection-details)
* [TypeScript SDK](https://tempo.xyz/developers/docs/sdk/typescript)
* [Wallet integration](https://tempo.xyz/developers/docs/quickstart/wallet-developers)

### Send concurrent transactions with nonce keys

To send multiple transactions in parallel, simply batch them together. [Expiring nonces](https://tempo.xyz/developers/docs/guide/tempo-transaction#expiring-nonces) are attached to each transaction automatically.

:::code-group
```ts twoslash [example.ts]
// @noErrors
import { Hooks } from 'wagmi/tempo'
import { parseUnits } from 'viem'

const alphaUsd = '0x20c0000000000000000000000000000000000001'

const { mutate: transfer } = Hooks.token.useTransferSync()

// Send both transfers in parallel. // [!code focus]
const [receipt1, receipt2] = await Promise.all([ // [!code focus]
  transfer.mutate({ // [!code focus]
    amount: parseUnits('100', 6), // [!code focus]
    to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // [!code focus]
    token: alphaUsd, // [!code focus]
  }), // [!code focus]
  transfer.mutate({ // [!code focus]
    amount: parseUnits('50', 6), // [!code focus]
    to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // [!code focus]
    token: alphaUsd, // [!code focus]
  }), // [!code focus]
]) // [!code focus]

console.log('Transaction 1:', receipt1.transactionHash) // [!code focus]
console.log('Transaction 2:', receipt2.transactionHash) // [!code focus]
```

```tsx twoslash [wagmi.config.ts] filename="wagmi.config.ts"
// @noErrors
import { tempo } from 'viem/chains'
import { createConfig, http } from 'wagmi'
import { tempoWallet } from 'wagmi/connectors'

export const config = createConfig({
  connectors: [tempoWallet()],
  chains: [tempo],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempo.id]: http(),
  },
})
```
:::
::::

## Parallel transaction learning resources

* [Expiring Nonces](https://tempo.xyz/developers/docs/guide/tempo-transaction#expiring-nonces) — Learn more about expiring nonces that power concurrent transactions.
* [Transactions](https://tempo.xyz/developers/docs/protocol/transactions) — Learn more about Tempo Transactions and their properties.
