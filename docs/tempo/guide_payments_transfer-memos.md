# Attach a Transfer Memo

Attach 32-byte references to [TIP-20](https://tempo.xyz/developers/docs/protocol/tip20/overview) transfers for payment reconciliation. Use memos to link onchain transactions to your internal records—customer IDs, invoice numbers, or any identifier that helps you match payments to your database.

## Transfer memo demo

**Interactive demo: Transfer with Memo**

1. Connect
2. Add funds
3. Send payment with memo

Source: [tempoxyz/examples/tree/main/examples/payments](https://github.com/tempoxyz/examples/tree/main/examples/payments)

## Transfer memo implementation steps

::::steps
### Set up your project for transfer memos

Ensure you have Wagmi configured with Tempo:

* [Connection details](https://tempo.xyz/developers/docs/quickstart/connection-details)
* [TypeScript SDK](https://tempo.xyz/developers/docs/sdk/typescript)
* [Wallet integration](https://tempo.xyz/developers/docs/quickstart/wallet-developers)

### Send a transfer with memo

Use `transferWithMemo` to attach a reference to your payment. The memo is a 32-byte value that gets emitted in the `TransferWithMemo` event.

:::code-group
```tsx twoslash [SendWithMemo.tsx]
// @noErrors
import { Hooks } from 'wagmi/tempo'
import { parseUnits, toHex } from 'viem'
import { useConnection } from 'wagmi'

export function SendWithMemo() {
  const { address } = useConnection()
  const transfer = Hooks.token.useTransferSync()

  const handleSend = () => {
    transfer.mutate({
      token: '0x20c0000000000000000000000000000000000001',
      to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb',
      amount: parseUnits('100', 6),
      memo: toHex('INV-12345', { size: 32 }),
    })
  }

  return (
    <button onClick={handleSend} disabled={transfer.isPending}>
      {transfer.isPending ? 'Sending...' : 'Send Payment'}
    </button>
  )
}
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

### Watch for transfers with memos

Listen for `TransferWithMemo` events to reconcile incoming payments. The memo is indexed, so you can filter by specific values.

:::code-group
```tsx twoslash [WatchMemos.tsx]
// @noErrors
import { useWatchContractEvent } from 'wagmi'
import { fromHex } from 'viem'
import { Abis } from 'viem/tempo'

export function WatchMemos({ depositAddress }: { depositAddress: `0x${string}` }) {
  useWatchContractEvent({
    address: '0x20c0000000000000000000000000000000000001',
    abi: Abis.TIP20,
    eventName: 'TransferWithMemo',
    onLogs: (logs) => {
      for (const log of logs) {
        if (log.args.to === depositAddress) {
          const memo = fromHex(log.args.memo, 'string').replace(/\0/g, '')
          console.log(`Received ${log.args.value} with memo: ${memo}`)
        }
      }
    },
  })

  return <div>Watching for deposits...</div>
}
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

## Transfer memo recipes

### Exchange deposit reconciliation

As an exchange, use a single master hot wallet for all customer deposits. Customers include their customer ID as the memo, and you credit their account by parsing the event.

```ts
import { Actions } from 'viem/tempo'
import { parseUnits, stringToHex, pad } from 'viem'

// Customer deposits with their customer ID
await Actions.token.transferSync(walletClient, {
  token: tokenAddress,
  to: exchangeHotWallet,
  amount: parseUnits('500', 6),
  memo: pad(stringToHex('CUST-12345'), { size: 32 }),
})
```

### Payroll batch payments

Start with the [Viem batch payment setup](https://tempo.xyz/developers/docs/guide/payments/send-a-payment#batch-payment-transactions), then encode `transferWithMemo` for each employee ID.

```ts
import { Abis } from 'viem/tempo'
import { encodeFunctionData, parseUnits, stringToHex, pad } from 'viem'
import { client } from './viem.config'

const calls = employees.map(emp => ({
  to: tokenAddress,
  data: encodeFunctionData({
    abi: Abis.tip20,
    functionName: 'transferWithMemo',
    args: [emp.wallet, parseUnits(emp.salary, 6), pad(stringToHex(emp.id), { size: 32 })]
  })
}))

await client.sendTransaction({ calls })
```

### Refund address in memo

Include a refund address in the memo so the recipient knows where to send funds if a reversal is needed.

```ts
import { Actions } from 'viem/tempo'
import { parseUnits, stringToHex, pad } from 'viem'

const refundMemo = pad(stringToHex('REFUND 0x742d35Cc6634C0532925a3b8'), { size: 32 })

await Actions.token.transferSync(walletClient, {
  token: tokenAddress,
  to: merchantAddress,
  amount: parseUnits('100', 6),
  memo: refundMemo,
})
```

## Transfer memo best practices

### Use consistent memo formats

Establish a naming convention for your memos (e.g., `CUST-{id}`, `INV-{number}`, `REFUND-{id}`) to make parsing and filtering reliable across your system.

### Keep memos under 32 bytes

Memos are `bytes32` values. Use `toHex(string, { size: 32 })` to convert strings—if your string exceeds 32 bytes, it will be truncated. For longer references, store the full data offchain and use a hash or short ID as the memo.

### Index memos for efficient queries

The `TransferWithMemo` event has `memo` as an indexed parameter. Use `getLogs` with the `args` filter to query transactions by memo without scanning all events.

```ts
import { parseAbiItem, stringToHex, pad } from 'viem'

const logs = await client.getLogs({
  address: tokenAddress,
  event: parseAbiItem('event TransferWithMemo(address indexed from, address indexed to, uint256 value, bytes32 indexed memo)'),
  args: { memo: pad(stringToHex('INV-12345'), { size: 32 }) },
})
```

## Transfer memo learning resources

* [Send a Payment](https://tempo.xyz/developers/docs/guide/payments/send-a-payment) — Complete guide to sending stablecoin payments with optional memos
* [Accept a Payment](https://tempo.xyz/developers/docs/guide/payments/accept-a-payment) — Watch for incoming payments and integrate reconciliation flows
* [TIP-20 Specification](https://tempo.xyz/developers/docs/protocol/tip20/spec) — Full API reference for memo methods and events
