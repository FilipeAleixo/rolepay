// The treasurer's transactions, signed in the browser with the passkey (WebAuthn P256), sent
// straight to Tempo. Fees go through the sponsor when one is configured (testnet: the public
// Moderato sponsor), otherwise the treasury pays them in its fee token.
import { Abis, type Account, createClient, http, withRelay } from 'viem/tempo'
import { type WireAuthorization, authorizeKeyCall, rotationCalls } from './keychain.js'

export type { WireAuthorization }
export type ChainConfig = { rpcUrl: string; sponsorUrl: string | null; testnet: boolean; feeToken: string }

/** viem's default 25 s validBefore goes stale on a slow passkey prompt plus RPC retries. */
const VALID_BEFORE_SECONDS = 120

function client(c: ChainConfig, account?: Account.Account) {
  const rpc = http(c.rpcUrl, { retryCount: 4, retryDelay: 400 })
  const transport = c.sponsorUrl ? withRelay(rpc, http(c.sponsorUrl, { retryCount: 0 })) : rpc
  return createClient({ ...(account ? { account } : {}), testnet: c.testnet, transport })
}

const feeFields = (c: ChainConfig) =>
  c.sponsorUrl ? { feePayer: true, validBefore: Math.floor(Date.now() / 1000) + VALID_BEFORE_SECONDS } : { feeToken: c.feeToken }

/**
 * Root (passkey) authorises the bot's access key on the Account Keychain: expiry, limits, call
 * scope. One transaction from the root calling authorizeKey, so one passkey prompt (keychain.ts).
 * Replacing a key: the same transaction first revokes every key in `revoke` (still one prompt).
 */
export async function authorizeAccessKey(c: ChainConfig, root: Account.Account, keyAddress: string, auth: WireAuthorization, revoke: readonly string[] = []) {
  const receipt = revoke.length
    ? await client(c, root).sendTransactionSync({ calls: rotationCalls(keyAddress, auth, revoke), throwOnReceiptRevert: true, ...feeFields(c) } as never)
    : await client(c, root).writeContractSync({ ...authorizeKeyCall(keyAddress, auth), throwOnReceiptRevert: true, ...feeFields(c) } as never)
  if (receipt.status !== 'success') throw new Error(`the authorisation transaction ${receipt.transactionHash} reverted`)
  return receipt.transactionHash as string
}

export async function revokeAccessKey(c: ChainConfig, root: Account.Account, keyAddress: string) {
  const { receipt } = await client(c, root).accessKey.revokeSync({ accessKey: keyAddress as `0x${string}`, ...feeFields(c) } as never)
  if (receipt.status !== 'success') throw new Error(`the revoke transaction ${receipt.transactionHash} reverted`)
  return receipt.transactionHash as string
}

export async function balanceOf(c: ChainConfig, token: string, address: string): Promise<bigint> {
  return (await client(c).readContract({ address: token as `0x${string}`, abi: Abis.tip20, functionName: 'balanceOf', args: [address as `0x${string}`] })) as bigint
}

/** Testnet only: the public faucet funds the address with every testnet stablecoin. */
export async function faucet(c: ChainConfig, address: string) {
  if (!c.testnet) throw new Error('the faucet is testnet only')
  await client(c).faucet.fundSync({ account: address as `0x${string}`, timeout: 60_000 })
}
