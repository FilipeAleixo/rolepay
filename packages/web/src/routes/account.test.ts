import { MAINNET_TOKENS, TESTNET_TOKENS } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { pageConfig, webHarness } from '../../test/harness.js'

describe("the payee's account page (/account)", () => {
  it('on mainnet: the known stablecoins (USDC.e first), no sponsor, the mainnet RPC and explorer, and no testnet badge', async () => {
    const h = webHarness({ mainnet: true })
    const res = await h.send('/account')
    expect(res.status).toBe(200)
    const html = await res.clone().text()
    expect(await pageConfig(res)).toEqual({
      page: 'account',
      network: 'mainnet',
      testnet: false,
      rpcUrl: 'https://rpc.tempo.xyz',
      sponsorUrl: null,
      explorerUrl: 'https://explore.tempo.xyz',
      tokens: [
        { address: MAINNET_TOKENS.usdc_e, label: 'USDC.e' },
        { address: MAINNET_TOKENS.path_usd, label: 'pathUSD' },
        { address: MAINNET_TOKENS.ousd, label: 'OUSD' },
        { address: MAINNET_TOKENS.usdt0, label: 'USDT0' },
      ],
    })
    expect(html).not.toContain('class="testnet"')
    expect(html).toContain('<button id="signin" type="button">Sign in with my passkey</button>')
    expect(html).toContain('<option value="0x20c000000000000000000000b9537d11c60e8b50">USDC.e</option>')
    // Without a sponsor the fee comes out of the token sent: the page says so, and Max keeps a reserve.
    expect(html).toMatch(/network fee[^<]*paid from the token you send/)
    expect(html).toMatch(/cannot be undone/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toMatch(/connect-src 'self' https:\/\/rpc\.tempo\.xyz;/)
  })

  it('on testnet: the faucet tokens, the sponsor pays the fee', async () => {
    const res = await webHarness().send('/account')
    const config = await pageConfig(res.clone())
    expect(config).toMatchObject({ network: 'moderato', testnet: true, sponsorUrl: 'https://sponsor.moderato.tempo.xyz' })
    expect((config.tokens as { address: string }[]).map((t) => t.address)).toEqual([TESTNET_TOKENS.alpha_usd, TESTNET_TOKENS.path_usd, TESTNET_TOKENS.beta_usd, TESTNET_TOKENS.theta_usd])
    expect(await res.text()).toMatch(/network fee is paid by the sponsor/)
  })

  it('has no server endpoint: the passkey signs in the browser and sends straight to Tempo, so the server never takes an address or an amount', async () => {
    const h = webHarness()
    expect((await h.post('/account', { to: '0x7777777777777777777777777777777777777777', amount: '1' })).status).toBe(404)
  })
})
