// The wallet steps against a fake EIP-1193 provider (window.ethereum) backed by a viem local account:
// it knows some chains, switches like MetaMask, can be told to refuse, and signs for real. What it
// pins: the page asks for Tempo by viem's definition (adding it when the wallet does not know it),
// reads the selected account, signs the exact text, and a person declining reads a calm sentence.
import { recoverMessageAddress } from 'viem'
import { tempo, tempoModerato } from 'viem/tempo/chains'
import { describe, expect, it } from 'vitest'
import { fakeWallet } from '../../test/fakeWallet.js'
import {
  WALLET_DECLINED,
  WalletError,
  addChainParams,
  connectWallet,
  explainWalletClaim,
  explainWalletError,
  injectedWallet,
  isUserRejection,
  signClaim,
} from './wallet.js'

describe('connecting a wallet the payee already has', () => {
  it('switches a wallet that knows Tempo to it and returns the selected account, lowercase', async () => {
    const w = fakeWallet({ knows: [1, 42431] })
    expect(await connectWallet(w.provider, 'moderato')).toBe(w.account.address.toLowerCase())
    expect(w.methods()).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts'])
    expect(w.calls[1]?.params).toEqual([{ chainId: '0xa5bf' }]) // 42431
  })

  it("adds Tempo the first time, from viem's chain definition (mainnet: 4217), then switches", async () => {
    const w = fakeWallet()
    expect(await connectWallet(w.provider, 'mainnet')).toBe(w.account.address.toLowerCase())
    expect(w.methods()).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts'])
    expect(w.calls[2]?.params).toEqual([
      { chainId: '0x1079', chainName: tempo.name, nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: ['https://rpc.tempo.xyz'], blockExplorerUrls: ['https://explore.tempo.xyz'] },
    ])
    expect(addChainParams('moderato')).toMatchObject({ chainId: '0xa5bf', chainName: tempoModerato.name, rpcUrls: ['https://rpc.moderato.tempo.xyz'], blockExplorerUrls: ['https://explore.testnet.tempo.xyz'] })
  })

  it('also when a mobile wallet wraps "unknown chain" in an internal error', async () => {
    const w = fakeWallet({ wrapUnknownChain: true })
    await connectWallet(w.provider, 'moderato')
    expect(w.methods()).toContain('wallet_addEthereumChain')
  })

  it('a wallet that does not end up on Tempo is refused before anything is signed', async () => {
    const w = fakeWallet({ knows: [1, 42431], stays: true })
    const error = await connectWallet(w.provider, 'moderato').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WalletError)
    expect(explainWalletError(error)).toBe('Your wallet did not switch to Tempo (chain 42431). Switch it to Tempo and try again.')
    expect(w.methods()).not.toContain('personal_sign')
  })

  it('a person declining to connect, to switch or to sign reads a calm sentence, not an error', async () => {
    for (const method of ['eth_requestAccounts', 'wallet_switchEthereumChain', 'personal_sign']) {
      const w = fakeWallet({ knows: [42431], refuse: [method] })
      const error = await connectWallet(w.provider, 'moderato')
        .then((address) => signClaim(w.provider, address, 'hello'))
        .catch((e: unknown) => e)
      expect(isUserRejection(error), method).toBe(true)
      expect(explainWalletError(error), method).toBe(WALLET_DECLINED)
    }
    expect(WALLET_DECLINED).toBe('You closed the request in your wallet, so nothing was registered. Try again when you are ready, or create a passkey instead.')
  })

  it('finds the injected wallet, or says there is none', () => {
    const w = fakeWallet()
    expect(injectedWallet({ ethereum: w.provider })).toBe(w.provider)
    expect(injectedWallet({})).toBeNull()
    expect(injectedWallet({ ethereum: { notAProvider: true } })).toBeNull()
    expect(explainWalletError(new WalletError('no_wallet'))).toMatch(/^No wallet found in this browser\./)
  })
})

describe('signing the claim message', () => {
  it('asks personal_sign for the exact text (as UTF-8 hex, which wallets show as text) and returns a signature over it', async () => {
    const w = fakeWallet({ knows: [42431] })
    const address = await connectWallet(w.provider, 'moderato')
    const message = 'Rolepay on web.rolepay.app: pay me in Mods guild at 0x... on Tempo (chain 42431).\n\nIssued at: now'
    const signature = await signClaim(w.provider, address, message)
    const sign = w.calls.find((c) => c.method === 'personal_sign')
    expect(sign?.params?.[1]).toBe(address)
    expect(Buffer.from((sign?.params?.[0] as string).slice(2), 'hex').toString('utf8')).toBe(message)
    expect((await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase()).toBe(address)
  })

  it("the server's refusals, in words: an unsupported signature type says to use a passkey", () => {
    expect(explainWalletClaim('unsupported_signature')).toBe("This wallet's signature type isn't supported yet; use a passkey.")
    for (const code of ['nonce_mismatch', 'nonce_expired', 'signature_mismatch', 'wrong_chain', 'malformed_message', 'not_configured', 'invalid_input', 'rate_limited', 'malformed_signature']) {
      expect(explainWalletClaim(code), code).toMatch(/^[A-Z].*\.$/)
      expect(explainWalletClaim(code), code).not.toContain('—')
    }
    expect(explainWalletClaim('something_new')).toBe('Could not register (something_new).')
  })
})
