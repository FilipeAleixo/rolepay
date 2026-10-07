import type { NetworkName } from '@rolepay/core'
import { errorFields } from './logging.js'

export type ChainCheck =
  | { ok: true }
  | { ok: false; code: 'wrong_chain'; expected: number; actual: number }
  | { ok: false; code: 'unreachable'; detail: string }

/**
 * Whether the RPC is the network the config names, read once at start. A wrong chain (a mainnet
 * server pointed at a testnet RPC, or the reverse) means the server must not start: the caller
 * refuses. An RPC that is down or slow only gets a log line: the server still answers Discord,
 * and payments wait for the chain anyway.
 */
export async function checkChain(expected: { network: NetworkName; chainId: number }, read: () => Promise<number>, timeoutMs = 10_000): Promise<ChainCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const actual = await Promise.race([read(), timeout])
    if (actual === 'timeout') return { ok: false, code: 'unreachable', detail: `no answer within ${timeoutMs} ms` }
    return actual === expected.chainId ? { ok: true } : { ok: false, code: 'wrong_chain', expected: expected.chainId, actual }
  } catch (error) {
    return { ok: false, code: 'unreachable', detail: errorFields(error).error }
  } finally {
    clearTimeout(timer)
  }
}
