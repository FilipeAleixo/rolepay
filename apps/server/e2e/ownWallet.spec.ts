// Browser end to end on Moderato: "Use a wallet I already have". The real server, page and client
// bundle; window.ethereum is a fake EIP-1193 wallet injected into the page, its key a viem local
// account in this process (it signs exactly what MetaMask's personal_sign would). On a phone-width
// screen (375 px) the payee picks the wallet, the page adds and switches to Tempo, the wallet signs
// the server's message, and a real run then pays that address, its balance rising by the amount.
import { expect, test } from '@playwright/test'
import { rootSignerFromPrivateKey } from '@rolepay/core/adapters'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { NET, startServer } from './harness.js'

const PORT = 8803
const TOKEN = '0x20c0000000000000000000000000000000000001' // AlphaUSD
const TREASURER = '300000000000000001'
const PAYEE = '200000000000000005'
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)

let server: Awaited<ReturnType<typeof startServer>>
test.beforeAll(async () => {
  server = await startServer(PORT)
})
test.afterAll(async () => {
  await server?.stop()
})

let cspViolations: string[] = []
test.beforeEach(async ({ page }) => {
  cspViolations = []
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text())
  })
})
test.afterEach(() => {
  expect(cspViolations).toEqual([])
})

test('a payee registers the wallet they already have on a phone-width claim page, and a real run pays it', async ({ page }) => {
  // A community with a throwaway treasury, funded from the faucet, its bot key authorised by the in-process root (the dev path).
  const guildId = snowflake()
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  await server.testnet.ensureFunded(root.address, TOKEN, 5_000_000n)
  expect((await server.rolepay.communities.register({ guildId, name: 'E2E wallet guild', treasuryAddress: root.address, payoutToken: TOKEN, feeMode: 'sponsor' })).ok).toBe(true)
  await server.rolepay.communities.provisionBotKey({ guildId, limit: 5_000_000n, periodSeconds: 86_400, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  expect((await server.rolepay.communities.authorizeBotKey({ guildId, root })).ok).toBe(true)

  // The wallet: an injected EIP-1193 provider that knows only Ethereum mainnet at first, signing in this process.
  const wallet = privateKeyToAccount(generatePrivateKey())
  const address = wallet.address.toLowerCase()
  await page.exposeFunction('rolepayTestSign', (raw: `0x${string}`) => wallet.signMessage({ message: { raw } }))
  await page.addInitScript((account: string) => {
    const state = { chainId: 1, known: new Set([1]), calls: [] as string[], added: null as unknown }
    ;(window as unknown as { __wallet: typeof state }).__wallet = state
    ;(window as unknown as { ethereum: unknown }).ethereum = {
      async request({ method, params }: { method: string; params?: { chainId?: string }[] }) {
        state.calls.push(method)
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account]
        if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`
        if (method === 'wallet_switchEthereumChain') {
          const id = Number.parseInt(params?.[0]?.chainId ?? '0x0', 16)
          if (!state.known.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
          state.chainId = id
          return null
        }
        if (method === 'wallet_addEthereumChain') {
          state.known.add(Number.parseInt(params?.[0]?.chainId ?? '0x0', 16))
          state.added = params?.[0]
          return null
        }
        if (method === 'personal_sign') return (window as unknown as { rolepayTestSign: (raw: unknown) => Promise<string> }).rolepayTestSign((params as unknown[])[0])
        throw Object.assign(new Error('unsupported'), { code: 4200 })
      },
    }
  }, wallet.address)

  // The claim page on a phone: two choices, passkey first, nothing wider than the screen.
  await page.setViewportSize({ width: 375, height: 812 })
  const link = await server.rolepay.payees.issueLink({ guildId, discordUserId: PAYEE, discordUsername: 'wallet_owner' })
  if (!link.ok) throw new Error(link.error.code)
  await page.goto(`${server.url}/claim/${link.value.token}`)
  const buttons = await page.locator('[data-step="choose"] button').allTextContents()
  expect(buttons.slice(0, 2)).toEqual(['Create my passkey (no wallet needed)', 'Use a wallet I already have'])
  await expect(page.getByText('Only an address you control on Tempo. Exchange deposit addresses usually cannot receive on Tempo')).toBeVisible()
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  expect(await noScroll()).toBe(true)
  await page.screenshot({ path: test.info().outputPath('claim-choose-375.png'), fullPage: true })

  await page.getByRole('button', { name: 'Use a wallet I already have' }).click()
  await expect(page.getByRole('heading', { name: 'You will be paid at your wallet' })).toBeVisible()
  await expect(page.locator('[data-step="done-wallet"]')).toContainText(`You will be paid at ${address}. Keep that wallet: Rolepay cannot move or recover money there.`)
  expect(await noScroll()).toBe(true)
  await page.screenshot({ path: test.info().outputPath('claim-done-375.png'), fullPage: true })
  const seen = (await page.evaluate(() => (window as unknown as { __wallet: { calls: string[]; added: unknown } }).__wallet)) as { calls: string[]; added: { chainId: string; chainName: string } }
  expect(seen.calls).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts', 'personal_sign'])
  expect(seen.added).toMatchObject({ chainId: '0xa5bf', chainName: 'Tempo Testnet (Moderato)' })
  expect(await server.rolepay.payees.get({ guildId, discordUserId: PAYEE })).toMatchObject({ ok: true, value: { address, addressKind: 'external' } })

  // A real run pays that address.
  const run = await server.rolepay.payRuns.create({ guildId, createdBy: TREASURER, note: 'e2e own wallet', lines: [{ discordUserId: PAYEE, amount: 1_000_000n }] })
  if (!run.ok) throw new Error(JSON.stringify(run.error))
  const ref = { guildId, runId: run.value.id }
  await server.rolepay.payRuns.submit({ ...ref, actor: TREASURER })
  await server.rolepay.payRuns.approve({ ...ref, actor: TREASURER, actorCanApprove: true })
  const paid = await server.rolepay.payRuns.execute(ref)
  if (!paid.ok) throw new Error(JSON.stringify(paid.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  expect(paid.value.status).toBe('paid')
  expect(await server.testnet.balance(TOKEN, address)).toBe(1_000_000n)
  console.log(`own wallet paid from the browser claim: ${NET.explorerUrl}/tx/${paid.value.run.paidTxHash}`)
})
