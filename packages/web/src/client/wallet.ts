// "Use a wallet I already have": an injected EIP-1193 wallet (window.ethereum, for example MetaMask).
// The wallet lives in the page, so nothing loads from another site and the CSP is unchanged. It is
// asked to switch to (or add) the configured Tempo chain, to share its selected account, and to sign
// the server's claim message with personal_sign. It never sends a transaction here.
import { stringToHex } from 'viem/utils'
import { tempo, tempoModerato } from 'viem/tempo/chains'

/** The part of EIP-1193 used here. */
export type Eip1193Provider = { request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> }

/** A wallet step that went wrong in a way the page explains (`explainWalletError`). */
export class WalletError extends Error {
  constructor(
    readonly code: 'no_wallet' | 'no_account' | 'wrong_chain' | 'bad_signature',
    readonly chainId?: number,
  ) {
    super(code)
    this.name = 'WalletError'
  }
}

/** The wallet the browser injected, if any. */
export function injectedWallet(scope: { ethereum?: unknown } = globalThis as { ethereum?: unknown }): Eip1193Provider | null {
  const eth = scope.ethereum as Partial<Eip1193Provider> | undefined
  return eth && typeof eth.request === 'function' ? (eth as Eip1193Provider) : null
}

/** The chain to ask for, from viem's own definitions: Tempo Mainnet (4217) or Moderato (42431). */
export const walletChain = (network: string) => (network === 'mainnet' ? tempo : tempoModerato)

const hexChainId = (id: number) => `0x${id.toString(16)}`
const codeOf = (e: unknown): unknown => (e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined)

/** The wallet does not know the chain yet: 4902 (EIP-3085), which some mobile wallets wrap in -32603. */
function unknownChain(e: unknown): boolean {
  if (codeOf(e) === 4902) return true
  const inner = e && typeof e === 'object' && 'data' in e ? (e as { data?: { originalError?: unknown } }).data?.originalError : undefined
  return codeOf(inner) === 4902 || /unrecognized chain|unknown chain/i.test(e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? ''))
}

/**
 * The parameters to add Tempo to a wallet that does not know it, from viem's chain definition. The
 * native currency is "USD" with 18 decimals, not viem's 6: Tempo has no native token (fees are in
 * stablecoins), wallets read `eth_getBalance` as 18 decimals (Tempo's EVM compatibility notes), and
 * MetaMask refuses any other number here.
 */
export function addChainParams(network: string) {
  const chain = walletChain(network)
  return {
    chainId: hexChainId(chain.id),
    chainName: chain.name,
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: [chain.blockExplorers.default.url],
  }
}

/**
 * Connects: asks for the account, switches the wallet to the network's Tempo chain (adding it the
 * first time), checks the wallet really is on it, and returns the selected account in lowercase.
 */
export async function connectWallet(provider: Eip1193Provider, network: string): Promise<string> {
  const chain = walletChain(network)
  await provider.request({ method: 'eth_requestAccounts' })
  const target = [{ chainId: hexChainId(chain.id) }]
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: target })
  } catch (error) {
    if (!unknownChain(error)) throw error
    await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(network)] })
    // MetaMask switches to a chain it has just added; ask once more for the wallets that do not.
    await provider.request({ method: 'wallet_switchEthereumChain', params: target })
  }
  const now = await provider.request({ method: 'eth_chainId' })
  if (typeof now !== 'string' || Number.parseInt(now, 16) !== chain.id) throw new WalletError('wrong_chain', chain.id)
  // The selected account, read after the switch (eth_accounts lists it first).
  const accounts = await provider.request({ method: 'eth_accounts' })
  const address = Array.isArray(accounts) ? accounts[0] : undefined
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new WalletError('no_account')
  return address.toLowerCase()
}

/** Asks the wallet to sign the claim message (personal_sign, the text as UTF-8 hex, which the wallet shows as text). */
export async function signClaim(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  const signature = await provider.request({ method: 'personal_sign', params: [stringToHex(message), address] })
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new WalletError('bad_signature')
  return signature
}

/** The person closed or declined the wallet's prompt (EIP-1193 4001): not a failure, and the page says so calmly. */
export const isUserRejection = (e: unknown) => codeOf(e) === 4001 || codeOf((e as { cause?: unknown } | null)?.cause) === 4001

export const WALLET_DECLINED = 'You closed the request in your wallet, so nothing was registered. Try again when you are ready, or create a passkey instead.'

/** A wallet step's failure in plain English. */
export function explainWalletError(error: unknown): string {
  if (isUserRejection(error)) return WALLET_DECLINED
  if (error instanceof WalletError) {
    switch (error.code) {
      case 'no_wallet':
        return 'No wallet found in this browser. Open this link in the browser where your wallet is (for example MetaMask), or create a passkey instead.'
      case 'wrong_chain':
        return `Your wallet did not switch to Tempo (chain ${error.chainId}). Switch it to Tempo and try again.`
      case 'no_account':
        return 'Your wallet did not share an account. Unlock it, choose an account and try again.'
      case 'bad_signature':
        return 'Your wallet did not return a signature. Nothing was registered; try again.'
    }
  }
  if (codeOf(error) === -32002) return 'Your wallet is already asking you something. Open it, finish or close that request, and try again.'
  return 'Something went wrong with your wallet. The details are in the browser console; try again in a moment.'
}

/** Why the server registered nothing, for a person (codes from POST /claim/:token/wallet and its challenge). */
export function explainWalletClaim(code: string): string {
  switch (code) {
    case 'unsupported_signature':
      return "This wallet's signature type isn't supported yet; use a passkey."
    case 'signature_mismatch':
      return 'That signature is not from the account your wallet showed. Nothing was registered; try again.'
    case 'nonce_mismatch':
    case 'nonce_expired':
      return 'That signing request expired or was already used. Nothing was registered; try again.'
    case 'malformed_signature':
      return 'Your wallet returned something that is not a signature. Nothing was registered; try again.'
    case 'wrong_chain':
    case 'wrong_origin':
    case 'malformed_message':
    case 'message_mismatch':
      return 'The signed message does not match this link. Nothing was registered; try again.'
    case 'not_configured':
      return 'This server does not take wallets yet. Create a passkey instead.'
    case 'invalid_input':
      return 'Your wallet shared an address this page cannot use. Choose another account and try again.'
    case 'rate_limited':
      return 'Too many tries just now. Wait a minute and try again.'
    default:
      return `Could not register (${code}).`
  }
}
