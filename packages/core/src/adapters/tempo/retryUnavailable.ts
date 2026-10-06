import type { Transport } from 'viem'

const UNAVAILABLE = /no healthy upstreams/i

/**
 * Retries requests the public RPC's load balancer refused with -32002 "no healthy
 * upstreams available" (seen on Moderato, 2026-10-06). viem does not retry that code.
 * The request never reached a node, so retrying is safe for every method, and a raw
 * tx re-sent is the same tx (same hash) anyway.
 */
export function retryUnavailable(base: Transport, opts: { retries?: number; delayMs?: number } = {}): Transport {
  const retries = opts.retries ?? 8
  const delayMs = opts.delayMs ?? 1500
  return (config) => {
    const t = base(config)
    const request = (async (args: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await t.request(args as never)
        } catch (error) {
          const e = error as { code?: number; message?: string; details?: string }
          const isUnavailable = e.code === -32002 || UNAVAILABLE.test(`${e.message ?? ''} ${e.details ?? ''}`)
          if (!isUnavailable || attempt >= retries) throw error
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
    }) as typeof t.request
    return { ...t, request }
  }
}
