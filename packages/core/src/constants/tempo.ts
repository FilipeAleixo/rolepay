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

/**
 * Mainnet USD stablecoins (TIP-20, 6 decimals, currency USD), from Tempo's token list
 * (tokenlist.tempo.xyz/list/4217) and read back on chain on 2026-10-07. USDC.e is Circle's USDC
 * bridged by Stargate (LayerZero); pathUSD is the protocol's fallback fee token; OUSD is Open
 * Standard's Open USD, which Tempo's docs recommend; USDT0 is Tether's LayerZero USDT.
 */
export const MAINNET_TOKENS = {
  usdc_e: '0x20c000000000000000000000b9537d11c60e8b50',
  path_usd: '0x20c0000000000000000000000000000000000000',
  ousd: '0x20c0000000000000000000006a37da5c996874be',
  usdt0: '0x20c00000000000000000000014f22ca97301eb73',
} as const

/** Display names of the tokens Rolepay knows, by lowercase address. pathUSD and OUSD have the same address on both networks. */
export const TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  [TESTNET_TOKENS.path_usd]: 'pathUSD',
  [TESTNET_TOKENS.alpha_usd]: 'AlphaUSD',
  [TESTNET_TOKENS.beta_usd]: 'BetaUSD',
  [MAINNET_TOKENS.usdc_e]: 'USDC.e',
  [MAINNET_TOKENS.ousd]: 'OUSD',
  [MAINNET_TOKENS.usdt0]: 'USDT0',
}

/** The tokens a payee's account page shows (and can send) on each network, the usual payout token first. */
export const KNOWN_TOKENS: Readonly<Record<NetworkName, readonly string[]>> = {
  moderato: [TESTNET_TOKENS.alpha_usd, TESTNET_TOKENS.path_usd, TESTNET_TOKENS.beta_usd],
  mainnet: [MAINNET_TOKENS.usdc_e, MAINNET_TOKENS.path_usd, MAINNET_TOKENS.ousd, MAINNET_TOKENS.usdt0],
}

/** Account Keychain precompile. Lowercase: the docs' mixed-case form fails viem's checksum check. */
export const KEYCHAIN_ADDRESS = '0xaaaaaaaa00000000000000000000000000000000'

/**
 * TIP-1022 virtual addresses (T3): the registry precompile, lowercase, and the 10-byte marker that
 * fills bytes 4 to 14 of every virtual address (docs/tempo/tip-1022.md).
 */
export const ADDRESS_REGISTRY = '0xfdc0000000000000000000000000000000000000'
export const VIRTUAL_MAGIC = 'fdfdfdfdfdfdfdfdfdfd'

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
