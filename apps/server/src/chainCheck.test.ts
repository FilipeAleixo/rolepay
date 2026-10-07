import { describe, expect, it } from 'vitest'
import { checkChain } from './chainCheck.js'

const mainnet = { network: 'mainnet' as const, chainId: 4217 }

describe('checkChain (the RPC is the network the config names, checked at start)', () => {
  it('passes when the RPC answers with the configured chain ID', async () => {
    expect(await checkChain(mainnet, async () => 4217)).toEqual({ ok: true })
  })

  it('refuses another chain: a mainnet config behind a testnet RPC (or the reverse) must not start', async () => {
    expect(await checkChain(mainnet, async () => 42431)).toEqual({ ok: false, code: 'wrong_chain', expected: 4217, actual: 42431 })
    expect(await checkChain({ network: 'moderato', chainId: 42431 }, async () => 4217)).toMatchObject({ ok: false, code: 'wrong_chain' })
  })

  it('an RPC that fails or does not answer is not a reason to stay down: unreachable, with any URL redacted', async () => {
    const failed = await checkChain(mainnet, async () => {
      throw new Error('HTTP request failed. URL: https://rpc.example/key-abc123 Status: 503')
    })
    expect(failed).toEqual({ ok: false, code: 'unreachable', detail: 'HTTP request failed. URL: <url> Status: 503' })
    expect(await checkChain(mainnet, () => new Promise<number>(() => {}), 20)).toEqual({ ok: false, code: 'unreachable', detail: 'no answer within 20 ms' })
  })
})
