import type { Transport } from 'viem'
import { describe, expect, it } from 'vitest'
import { retryUnavailable } from './retryUnavailable.js'

function flaky(failures: number, error: () => Error) {
  let calls = 0
  const transport = (() => ({
    config: {},
    value: undefined,
    request: async () => {
      calls++
      if (calls <= failures) throw error()
      return '0xa5bf'
    },
  })) as unknown as Transport
  return { transport, calls: () => calls }
}

const unavailable = () => Object.assign(new Error('RPC Request failed. Details: no healthy upstreams available'), { code: -32002 })
const call = (t: Transport) => t({ chain: undefined, retryCount: 0 }).request({ method: 'eth_chainId' } as never)

describe('retryUnavailable (public RPC answers -32002 "no healthy upstreams" intermittently)', () => {
  it('retries until the upstream is back', async () => {
    const f = flaky(3, unavailable)
    expect(await call(retryUnavailable(f.transport, { retries: 5, delayMs: 1 }))).toBe('0xa5bf')
    expect(f.calls()).toBe(4)
  })

  it('gives up after the configured retries', async () => {
    const f = flaky(10, unavailable)
    await expect(call(retryUnavailable(f.transport, { retries: 2, delayMs: 1 }))).rejects.toThrow('no healthy upstreams')
    expect(f.calls()).toBe(3)
  })

  it('does not retry other errors', async () => {
    const f = flaky(1, () => new Error('execution reverted'))
    await expect(call(retryUnavailable(f.transport, { retries: 5, delayMs: 1 }))).rejects.toThrow('execution reverted')
    expect(f.calls()).toBe(1)
  })
})
