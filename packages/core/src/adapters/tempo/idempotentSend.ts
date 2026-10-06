import { type Hex, type Transport, keccak256 } from 'viem'

const REPLAY_OR_LOST = /ExpiringNonceReplay|already known|nonce too low|HTTP request failed|timed out|took too long|internal error|fetch failed/i

/**
 * Wraps a transport so `eth_sendRawTransactionSync` is idempotent (ported from the spike).
 *
 * Seen on Moderato's public RPC: the sync send sometimes hangs ~60 s or returns an HTML
 * error page; viem's retry then re-broadcasts the SAME signed tx and the node answers
 * `ExpiringNonceReplay` although the first copy landed. The tx hash is keccak256(raw
 * signed envelope), so on those errors we look the receipt up by hash instead of failing.
 */
export function idempotentSend(base: Transport, opts: { pollIntervalMs?: number; maxPolls?: number } = {}): Transport {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000
  const maxPolls = opts.maxPolls ?? 30
  return (config) => {
    const t = base(config)
    const request = (async (args: { method: string; params?: unknown }) => {
      if (args.method !== 'eth_sendRawTransactionSync') return t.request(args as never)
      const raw = (args.params as Hex[])[0] as Hex
      const hash = keccak256(raw)
      try {
        return await t.request(args as never)
      } catch (error) {
        const msg = `${(error as Error).message ?? ''} ${(error as { details?: string }).details ?? ''}`
        if (!REPLAY_OR_LOST.test(msg)) throw error
        for (let i = 0; i < maxPolls; i++) {
          const receipt = await t.request({ method: 'eth_getTransactionReceipt', params: [hash] } as never).catch(() => null)
          if (receipt) return receipt
          await new Promise((r) => setTimeout(r, pollIntervalMs))
        }
        throw error
      }
    }) as typeof t.request
    return { ...t, request }
  }
}
