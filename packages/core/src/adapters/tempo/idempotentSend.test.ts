import { type Transport, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { idempotentSend } from './idempotentSend.js'

const RAW = '0x76f8aabbcc'
const RECEIPT = { transactionHash: keccak256(RAW), status: '0x1' }

/** A transport double whose `request` is scripted per method. */
function scripted(handlers: Record<string, (params: unknown) => unknown>): { transport: Transport; calls: string[] } {
  const calls: string[] = []
  const transport = (() => ({
    config: { key: 'fake', name: 'fake', type: 'fake', retryCount: 0, methods: undefined, timeout: undefined, request: undefined as never },
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push(method)
      const h = handlers[method]
      if (!h) throw new Error(`unexpected ${method}`)
      return h(params)
    },
    value: undefined,
  })) as unknown as Transport
  return { transport, calls }
}

const call = (t: Transport, method: string, params: unknown[] = []) =>
  t({ chain: undefined, retryCount: 0 }).request({ method, params } as never)

describe('idempotentSend (receipt recovery by hash, never re-sign)', () => {
  it('passes other methods straight through', async () => {
    const { transport } = scripted({ eth_blockNumber: () => '0x10' })
    expect(await call(idempotentSend(transport, { pollIntervalMs: 1 }), 'eth_blockNumber')).toBe('0x10')
  })

  it('on a replay error after the first copy landed, returns the receipt looked up by keccak256(raw)', async () => {
    const seen: unknown[] = []
    const { transport } = scripted({
      eth_sendRawTransactionSync: () => {
        throw new Error('ExpiringNonceReplay')
      },
      eth_getTransactionReceipt: (p) => {
        seen.push((p as string[])[0])
        return RECEIPT
      },
    })
    expect(await call(idempotentSend(transport, { pollIntervalMs: 1 }), 'eth_sendRawTransactionSync', [RAW])).toEqual(RECEIPT)
    expect(seen).toEqual([keccak256(RAW)])
  })

  it('keeps polling until the receipt shows up', async () => {
    let n = 0
    const { transport } = scripted({
      eth_sendRawTransactionSync: () => {
        throw new Error('The request took too long to respond.')
      },
      eth_getTransactionReceipt: () => (++n < 3 ? null : RECEIPT),
    })
    expect(await call(idempotentSend(transport, { pollIntervalMs: 1 }), 'eth_sendRawTransactionSync', [RAW])).toEqual(RECEIPT)
    expect(n).toBe(3)
  })

  it('rethrows the original error when no receipt appears, and rethrows definitive errors at once', async () => {
    const lost = scripted({
      eth_sendRawTransactionSync: () => {
        throw new Error('HTTP request failed')
      },
      eth_getTransactionReceipt: () => null,
    })
    await expect(call(idempotentSend(lost.transport, { pollIntervalMs: 1, maxPolls: 2 }), 'eth_sendRawTransactionSync', [RAW])).rejects.toThrow(
      'HTTP request failed',
    )
    const definitive = scripted({
      eth_sendRawTransactionSync: () => {
        throw new Error('keychain validation failed: AccountKeychainError(KeyExpired)')
      },
    })
    await expect(call(idempotentSend(definitive.transport, { pollIntervalMs: 1 }), 'eth_sendRawTransactionSync', [RAW])).rejects.toThrow(
      'KeyExpired',
    )
    expect(definitive.calls).toEqual(['eth_sendRawTransactionSync'])
  })
})
