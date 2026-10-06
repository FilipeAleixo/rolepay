import { Abis, createClient, http } from 'viem/tempo'
import { NETWORKS } from '../../constants/tempo.js'
import { retryUnavailable } from './retryUnavailable.js'

/**
 * Moderato-only helpers for dev and chain tests: faucet funding and balances.
 * Refuses to run against any chain but Moderato.
 */
export function createTestnetTools(opts: { rpcUrl: string }) {
  const client = createClient({ testnet: true, transport: retryUnavailable(http(opts.rpcUrl, { retryCount: 6, retryDelay: 400 })) })
  const assertTestnet = async () => {
    const id = await client.getChainId()
    if (id !== NETWORKS.moderato.chainId) throw new Error(`testnet tools refuse chain ${id}`)
  }
  const balance = async (token: string, address: string) =>
    client.readContract({ address: token as `0x${string}`, abi: Abis.tip20, functionName: 'balanceOf', args: [address as `0x${string}`] })
  return {
    chainId: () => client.getChainId(),
    balance,
    /** Tops `address` up from the public faucet (`tempo_fundAddress`) when below `min` of `token`. */
    async ensureFunded(address: string, token: string, min: bigint) {
      await assertTestnet()
      if ((await balance(token, address)) >= min) return
      await client.faucet.fundSync({ account: address as `0x${string}`, timeout: 60_000 })
    },
  }
}
