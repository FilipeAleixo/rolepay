import { describe, expect, it } from 'vitest'
import { KNOWN_TOKENS, MAINNET_TOKENS, NETWORKS, TESTNET_TOKENS, TOKEN_SYMBOLS } from './tempo.js'

describe('Tempo tokens', () => {
  it('names the mainnet stablecoins Rolepay pays in or takes fees in (tokenlist.tempo.xyz/list/4217, checked on chain 2026-10-07)', () => {
    expect(MAINNET_TOKENS).toEqual({
      usdc_e: '0x20c000000000000000000000b9537d11c60e8b50',
      path_usd: '0x20c0000000000000000000000000000000000000',
      ousd: '0x20c0000000000000000000006a37da5c996874be',
      usdt0: '0x20c00000000000000000000014f22ca97301eb73',
    })
    expect(TOKEN_SYMBOLS[MAINNET_TOKENS.usdc_e]).toBe('USDC.e')
    expect(TOKEN_SYMBOLS[MAINNET_TOKENS.path_usd]).toBe('pathUSD')
    expect(TOKEN_SYMBOLS[MAINNET_TOKENS.ousd]).toBe('OUSD')
    expect(TOKEN_SYMBOLS[MAINNET_TOKENS.usdt0]).toBe('USDT0')
  })

  it('keys every symbol by a lowercase TIP-20 address (the 0x20c0 prefix), so lookups by lowercased address work', () => {
    for (const address of Object.keys(TOKEN_SYMBOLS)) expect(address).toMatch(/^0x20c0[0-9a-f]{36}$/)
  })

  it('lists the tokens a payee may hold on each network, every one with a symbol', () => {
    expect(KNOWN_TOKENS.moderato).toEqual([TESTNET_TOKENS.alpha_usd, TESTNET_TOKENS.path_usd, TESTNET_TOKENS.beta_usd])
    expect(KNOWN_TOKENS.mainnet).toEqual([MAINNET_TOKENS.usdc_e, MAINNET_TOKENS.path_usd, MAINNET_TOKENS.ousd, MAINNET_TOKENS.usdt0])
    for (const network of Object.keys(NETWORKS) as (keyof typeof NETWORKS)[]) {
      for (const token of KNOWN_TOKENS[network]) expect(TOKEN_SYMBOLS[token]).toBeTruthy()
    }
  })

  it('mainnet: chain 4217, the public RPC, the explorer, and no fee sponsor (the hosted one needs an API key)', () => {
    expect(NETWORKS.mainnet).toMatchObject({ chainId: 4217, testnet: false, rpcUrl: 'https://rpc.tempo.xyz', sponsorUrl: null, explorerUrl: 'https://explore.tempo.xyz' })
  })
})
