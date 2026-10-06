# Sponsor user fees with `feePayer`

Enable gasless transactions by sponsoring transaction fees for your users. Tempo's native fee sponsorship allows applications to pay fees on behalf of users, improving UX and removing friction from payment flows.

## Fee sponsorship demo

**Interactive demo: Sponsor User Fees**

1. Connect
2. Add funds
3. Send relayer sponsored payment

## Fee sponsorship implementation steps

::::steps
### Set up the fee payer service

#### Hosted

See the [Fee Payer API guide](https://tempo.xyz/developers/docs/api/fee-payer) to set up authenticated production (and sandbox) sponsorship.

#### Self-hosted

Use the [Relay & Fee Payer Handler](https://tempo.xyz/developers/docs/server/relay-handler) to run a fee payer service with your own sponsorship policy.

:::info
For testing on Tempo testnet, use the public fee payer endpoint at `https://sponsor.moderato.tempo.xyz` without an API key.
:::

### Configure your client to use the fee payer service

:::code-group
```ts twoslash [Tempo Wallet]
// @noErrors
import { tempoModerato } from 'viem/chains'
import { createConfig, http } from 'wagmi'
import { tempoWallet } from 'wagmi/connectors'

export const config = createConfig({
  connectors: [tempoWallet({
    feePayer: 'https://sponsor.moderato.tempo.xyz', // [!code focus]
  })],
  chains: [tempoModerato],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempoModerato.id]: http(),
  },
})
```

```ts twoslash [WebAuthn + Other]
// @noErrors
import { tempoModerato } from 'viem/chains'
import { withRelay } from 'viem/tempo'
import { createConfig, http } from 'wagmi'
import { webAuthn } from 'wagmi/tempo'

export const config = createConfig({
  connectors: [webAuthn({ authUrl: '/auth' })],
  chains: [tempoModerato],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempoModerato.id]: withRelay( // [!code focus]
      http(), // [!code focus]
      http('https://sponsor.moderato.tempo.xyz'), // [!code focus]
    ), // [!code focus]
  },
})
```
:::

### Sponsor your user's transactions

Set `feePayer: true` to request sponsorship from the configured fee payer service. For more details on how to send a transaction, see the [Send a payment](https://tempo.xyz/developers/docs/guide/payments/send-a-payment) guide.

:::code-group
```tsx twoslash [SendSponsoredPayment.tsx] filename="SendSponsoredPayment.tsx"
import { Hooks } from 'wagmi/tempo'
import { parseUnits } from 'viem'

const alphaUsd = '0x20c0000000000000000000000000000000000001'

// @noErrors
function SendSponsoredPayment() {
  const sendPayment = Hooks.token.useTransferSync() // [!code hl]
  const metadata = Hooks.token.useGetMetadata({
    token: alphaUsd,
  })

  return (
    <form onSubmit={
      (event) => {
        event.preventDefault()
        const formData = new FormData(event.target as HTMLFormElement)

        const recipient = (formData.get('recipient') ||
          '0x0000000000000000000000000000000000000000') as `0x${string}`

        sendPayment.mutate({ // [!code hl]
          amount: parseUnits('100', metadata.data.decimals), // [!code hl]
          feePayer: true, // [!code focus]
          to: recipient, // [!code hl]
          token: alphaUsd, // [!code hl]
        }) // [!code hl]
      }
    }>
      <div>
        <label htmlFor="recipient"> Recipient address </label>
        <input type="text" placeholder="0x..." />
      </div>
      <button type="submit" disabled={sendPayment.isPending}>
        Send Payment
      </button>
    </form>
  )
}
```

```tsx twoslash [wagmi.config.ts] filename="wagmi.config.ts"
// @noErrors
import { tempoModerato } from 'viem/chains'
import { withRelay } from 'viem/tempo'
import { createConfig, http } from 'wagmi'
import { tempoWallet } from 'wagmi/connectors'

export const config = createConfig({
  connectors: [
    tempoWallet({
      feePayer: {
        precedence: 'user-first',
        url: 'https://sponsor.moderato.tempo.xyz',
      },
    }),
  ],
  chains: [tempoModerato],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempoModerato.id]: http(),
  },
})
```
:::

### Next steps for fee sponsorship

Now that you've implemented fee sponsorship, you can:

* Learn more about the [Tempo Transaction](https://tempo.xyz/developers/docs/protocol/transactions/spec-tempo-transaction#fee-payer-signature-details) type and fee payer signature details
* Use Tempo Transactions to sponsor multiple calls in a single signed operation
* Learn how to [Pay Fees in Any Stablecoin](https://tempo.xyz/developers/docs/guide/payments/pay-fees-in-any-stablecoin)
::::

## Fee sponsorship best practices

1. **Set sponsorship limits**: Implement daily or per-user limits to control costs
2. **Monitor expenses**: Track sponsorship costs regularly to stay within budget
3. **Consider selective sponsorship**: Only sponsor fees for specific operations or user segments
4. **Educate users**: Clearly communicate when fees are being sponsored

### Fee sponsorship security considerations

* **Transaction-specific**: Fee payer signatures are tied to specific transactions
* **No delegation risk**: Fee payer can't execute arbitrary transactions
* **Balance checks**: Network verifies fee payer has sufficient balance
* **Signature validation**: Both signatures must be valid

## Fee sponsorship learning resources

* [Fee Specification](https://tempo.xyz/developers/docs/protocol/fees/spec-fee) — Learn more about fees and how they work on Tempo
* [TempoTransaction Spec](https://tempo.xyz/developers/docs/protocol/transactions/spec-tempo-transaction) — Technical specification for TempoTransactions and fee payer signature details
* [Pay Fees in Any Stablecoin](https://tempo.xyz/developers/docs/guide/payments/pay-fees-in-any-stablecoin) — Understand fee token selection and how to pay with different stablecoins
