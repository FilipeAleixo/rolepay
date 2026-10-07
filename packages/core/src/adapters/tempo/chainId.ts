import { createPublicClient, http } from 'viem'

/** The chain ID the RPC at `rpcUrl` answers with (one eth_chainId call), so a server can check it serves the network it was configured for. */
export async function rpcChainId(rpcUrl: string): Promise<number> {
  return createPublicClient({ transport: http(rpcUrl, { retryCount: 2, retryDelay: 400 }) }).getChainId()
}
