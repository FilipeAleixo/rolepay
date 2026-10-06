/** Fixed Tempo network facts. Which network to use is config (`config/env.ts`), not a constant. */
export const NETWORKS = {
  moderato: {
    name: 'moderato',
    chainId: 42431,
    testnet: true,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    /** Public testnet fee sponsor, no API key (spike RESULTS.md). */
    sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
  },
  mainnet: {
    name: 'mainnet',
    chainId: 4217,
    testnet: false,
    rpcUrl: 'https://rpc.tempo.xyz',
    /** Mainnet sponsorship needs Tempo's hosted relay (API key) or a self-hosted one. */
    sponsorUrl: null,
    explorerUrl: 'https://explore.tempo.xyz',
  },
} as const

export type NetworkName = keyof typeof NETWORKS
export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[]
export type Network = (typeof NETWORKS)[NetworkName]

/** Testnet stablecoins the Moderato faucet funds (docs/tempo/quickstart_faucet.md). 6 decimals. */
export const TESTNET_TOKENS = {
  path_usd: '0x20c0000000000000000000000000000000000000',
  alpha_usd: '0x20c0000000000000000000000000000000000001',
  beta_usd: '0x20c0000000000000000000000000000000000002',
} as const

/** Account Keychain precompile. Lowercase: the docs' mixed-case form fails viem's checksum check. */
export const KEYCHAIN_ADDRESS = '0xaaaaaaaa00000000000000000000000000000000'

/** The only call the bot's access key may make. */
export const TRANSFER_WITH_MEMO_SIGNATURE = 'transferWithMemo(address,uint256,bytes32)'

/**
 * Expiring-nonce window for every bot-signed tx. viem defaults to 25 s, which RPC retries
 * outlive; T11 allows up to 5 minutes. After this window a signed tx can never land, which
 * is what makes a re-send after a crash provably safe.
 */
export const VALID_BEFORE_SECONDS = 120

/** Extra seconds of chain time to wait past validBefore before declaring a tx dead. */
export const VALID_BEFORE_MARGIN_SECONDS = 10
