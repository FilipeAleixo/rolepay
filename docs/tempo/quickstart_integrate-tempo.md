# Integrating Tempo: getting started

Use this section when you are connecting an existing app, wallet, contract, bridge, or infrastructure service to Tempo. These pages cover the practical edges of integration: chain configuration, RPC endpoints, faucet funding, wallet support, EVM compatibility, predeploys, contract verification, and ecosystem resources.

Tempo Mainnet has been live since March 18, 2026. Use mainnet for production integrations and Tempo Wallet. Use the separate Moderato testnet only for development and faucet-funded examples.

Tempo is EVM-compatible and targets the **Osaka** EVM hard fork. Most Ethereum tooling works as expected, with Tempo-specific differences documented where they matter.

## Connect and Fund

* [Connect to Tempo](https://tempo.xyz/developers/docs/quickstart/connection-details) — Add Tempo chain configuration, RPC endpoints, explorer links, and wallet connection details.
* [Get Testnet Funds](https://tempo.xyz/developers/docs/quickstart/faucet) — Fund test wallets so you can deploy contracts, send payments, and exercise integration flows.
* [Verify Contracts](https://tempo.xyz/developers/docs/quickstart/verify-contracts) — Verify deployed contracts and make them easier to inspect, debug, and share.

## App and Wallet Readiness

* [Wallet Integration](https://tempo.xyz/developers/docs/quickstart/wallet-developers) — Support Tempo in wallets with stablecoin-native fees, chain metadata, and transaction behavior.
* [Tempo EVM Compatibility](https://tempo.xyz/developers/docs/quickstart/evm-compatibility) — Understand the Tempo-specific behavior that differs from default Ethereum assumptions.
* [System Contracts and Predeploys](https://tempo.xyz/developers/docs/quickstart/predeployed-contracts) — Find Tempo predeploys and system contracts used by integrations and protocol features.
* [Token Lists](https://tempo.xyz/developers/docs/quickstart/tokenlist) — Use Tempo token lists to discover supported assets and present stablecoins correctly.

## Bridges and Ecosystem

* [Migrate an ERC-20 to TIP-20](https://tempo.xyz/developers/docs/guide/issuance/migrate-erc20-to-tip20) — Choose native issuance, a bridge adapter, full migration, or an external lifecycle manager for an existing ERC-20.
* [LayerZero Bridge](https://tempo.xyz/developers/docs/guide/bridge-layerzero) — Bridge supported assets to and from Tempo using LayerZero.
* [Relay Bridge](https://tempo.xyz/developers/docs/guide/bridge-relay) — Use Relay to move assets between Tempo and other supported networks.
* [Tempo Ecosystem](https://tempo.xyz/developers/docs/ecosystem) — Find bridges, wallets, analytics, infrastructure, compliance, and orchestration partners.
