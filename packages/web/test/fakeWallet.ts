// A browser wallet as a page sees it (window.ethereum, EIP-1193), backed by a viem local account: it
// knows some chains, switches like MetaMask, can be told to decline, and signs for real. For the
// client tests; the Playwright e2e injects the same shape into a real page.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

type Request = { method: string; params?: readonly unknown[] }

/** `knows`: chain IDs it has; `refuse`: methods the person declines (4001); `stays`: it never really switches. */
export function fakeWallet(opts: { knows?: number[]; chainId?: number; refuse?: string[]; stays?: boolean; wrapUnknownChain?: boolean } = {}) {
  const account = privateKeyToAccount(generatePrivateKey())
  const known = new Set(opts.knows ?? [1])
  let chainId = opts.chainId ?? 1
  const calls: Request[] = []
  const provider = {
    async request(r: Request): Promise<unknown> {
      calls.push(r)
      if (opts.refuse?.includes(r.method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      const first = (r.params?.[0] ?? {}) as { chainId?: string }
      switch (r.method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address]
        case 'eth_chainId':
          return `0x${chainId.toString(16)}`
        case 'wallet_switchEthereumChain': {
          const id = Number.parseInt(first.chainId ?? '0x0', 16)
          if (!known.has(id)) {
            const unknown = Object.assign(new Error(`Unrecognized chain ID "${first.chainId}".`), { code: 4902 })
            throw opts.wrapUnknownChain ? Object.assign(new Error('Internal error'), { code: -32603, data: { originalError: unknown } }) : unknown
          }
          if (!opts.stays) chainId = id
          return null
        }
        case 'wallet_addEthereumChain':
          known.add(Number.parseInt(first.chainId ?? '0x0', 16))
          return null
        case 'personal_sign':
          return account.signMessage({ message: { raw: r.params?.[0] as `0x${string}` } })
        default:
          throw Object.assign(new Error('unsupported'), { code: 4200 })
      }
    },
  }
  return { provider, account, calls, methods: () => calls.map((c) => c.method) }
}
