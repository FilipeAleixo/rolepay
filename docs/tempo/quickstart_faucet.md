# Tempo faucet: get testnet funds

Get test stablecoins on Tempo testnet.

## Fund an address

Send test stablecoins to any address.

**Interactive demo: Fund an address**

1. Add funds to others

## Fund your wallet

Connect your wallet to receive test stablecoins directly.

**Interactive demo: Connect and fund your wallet**

1. Connect wallet
2. Add funds to wallet
3. Add tokens to wallet
4. Set fee token

## cURL request

Request tokens programmatically via the faucet API.

```bash
curl -X POST https://tempo.xyz/developers/api/faucet \
  -H "Content-Type: application/json" \
  -d '{"address": "<YOUR_ADDRESS>"}'
```

Replace `<YOUR_ADDRESS>` with a lowercase wallet address.

## Cast RPC

Request tokens using the `tempo_fundAddress` RPC method.

```bash
cast rpc tempo_fundAddress <YOUR_ADDRESS> \
  --rpc-url https://rpc.moderato.tempo.xyz
```

Replace `<YOUR_ADDRESS>` with your wallet address.

The faucet funds the following assets.

| Asset | Address |Amount|
|-------|---------|----:|
| [OUSD](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000006a37da5c996874be) | `0x20c0000000000000000000006a37da5c996874be` | `1M` |
| [pathUSD](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000000000000000000000) | `0x20c0000000000000000000000000000000000000` | `1M` |
| [AlphaUSD](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000000000000000000001) | `0x20c0000000000000000000000000000000000001` | `1M` |
| [BetaUSD](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000000000000000000002) | `0x20c0000000000000000000000000000000000002` | `1M` |
| [ThetaUSD](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000000000000000000003)   | `0x20c0000000000000000000000000000000000003` | `1M` |
