// The mainnet path, rehearsed on the Moderato TESTNET: the server has no fee sponsor
// (ROLEPAY_SPONSOR_URL=none), exactly as on mainnet, so every fee is paid in a stablecoin by
// whoever signs. The treasurer's passkey authorises the bot key and pays that fee in pathUSD; the
// bot pays a run from its pathUSD fee budget; a payee signs in on their account page and sends
// part of what they were paid, the fee coming out of the token sent; the treasurer revokes the key.
import { type Browser, type Page, expect, test } from '@playwright/test'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { NET, passkeyPrompts, startServer, virtualAuthenticator } from './harness.js'

const PORT = 8798
const ALPHA_USD = '0x20c0000000000000000000000000000000000001' // the payout token here (USDC.e on mainnet)
const PATH_USD = '0x20c0000000000000000000000000000000000000' // the fee token, as on mainnet
const ROLE = '400000000000000001'
const TREASURER = '300000000000000001'
const PAYEE = '200000000000000009'
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)

let server: Awaited<ReturnType<typeof startServer>>
test.beforeAll(async () => {
  server = await startServer(PORT, { ROLEPAY_SPONSOR_URL: 'none' })
})
test.afterAll(async () => {
  await server?.stop()
})

/** One person on one device: their own browser profile, passkeys and dialogs. */
async function person(browser: Browser): Promise<{ page: Page; csp: string[] }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const csp: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) csp.push(m.text())
  })
  page.on('dialog', (d) => void d.accept())
  await virtualAuthenticator(page)
  return { page, csp }
}

test('no sponsor, as on mainnet: fees in pathUSD from the treasury and the fee budget, and a payee moves their money from the account page', async ({ browser }) => {
  const guildId = snowflake()
  const treasurer = await person(browser)
  const payee = await person(browser)

  // 1. The first setup on a server without a sponsor is a fee budget in pathUSD (what /rolepay setup now picks).
  const link = await server.rolepay.communities.issueSetupLink({
    guildId,
    discordUserId: TREASURER,
    settings: { name: 'Mainnet rehearsal', payoutToken: ALPHA_USD, feeMode: 'fee_budget', feeToken: PATH_USD, approverRoleId: ROLE },
  })
  if (!link.ok) throw new Error(link.error.code)
  const t = treasurer.page
  await t.goto(`${server.url}/setup/${link.value.token}`)
  await t.getByRole('button', { name: 'Create the treasury passkey' }).click()
  await expect(t.locator('#status')).toHaveText('Signed in as the treasury.')
  const community = await server.rolepay.communities.get(guildId)
  if (!community.ok) throw new Error('not registered')
  const treasury = community.value.treasuryAddress
  await expect(t.getByText(/Also send about 2 pathUSD/)).toBeVisible()

  // 2. Fund it (the faucet stands in for a bridge here): both balances show.
  await t.getByRole('button', { name: 'Get testnet funds' }).click()
  await expect(t.locator('#status')).toHaveText('Testnet funds arrived.')
  await expect(t.locator('[data-field="fee-balance"]')).not.toHaveText('...')
  const alphaBefore = await server.testnet.balance(ALPHA_USD, treasury)
  const pathBefore = await server.testnet.balance(PATH_USD, treasury)
  expect(pathBefore).toBeGreaterThan(0n)

  // 3. The bot key with a fee budget. No sponsor: the treasury pays this transaction's fee itself, in pathUSD.
  await t.locator('#limit').fill('5')
  await t.locator('#periodDays').fill('1')
  await t.locator('#validityDays').fill('2')
  await t.locator('#feeBudget').fill('0.5')
  await expect(t.locator('[data-field="key-signs"]')).toContainText('plus up to 0.5 pathUSD every day for fees')
  await t.getByRole('button', { name: 'Authorise the bot key with my passkey' }).click()
  await expect(t.locator('#status')).toContainText('The bot key is active')
  expect(await server.testnet.balance(PATH_USD, treasury)).toBeLessThan(pathBefore)
  expect(await server.testnet.balance(ALPHA_USD, treasury)).toBe(alphaBefore)
  console.log(`unsponsored authorisation: ${await t.locator('#status').textContent()}`)

  // 4. The payee registers with a passkey of their own, on their own device.
  const claim = await server.rolepay.payees.issueLink({ guildId, discordUserId: PAYEE })
  if (!claim.ok) throw new Error(claim.error.code)
  const p = payee.page
  await p.goto(`${server.url}/claim/${claim.value.token}`)
  await p.getByRole('button', { name: 'Create my passkey' }).click()
  await expect(p.getByRole('heading', { name: 'You will be paid here' })).toBeVisible()
  const account = (await p.locator('#address').textContent())?.trim() as string
  await expect(p.getByRole('link', { name: 'your Rolepay account' })).toHaveAttribute('href', '/account')

  // 5. The bot pays from the treasury; the fee comes out of the fee budget, the payout limit stays exact.
  const run = await server.rolepay.payRuns.create({ guildId, createdBy: TREASURER, note: 'rehearsal', lines: [{ discordUserId: PAYEE, amount: 2_000_000n }] })
  if (!run.ok) throw new Error(JSON.stringify(run.error))
  const ref = { guildId, runId: run.value.id }
  await server.rolepay.payRuns.submit({ ...ref, actor: TREASURER })
  await server.rolepay.payRuns.approve({ ...ref, actor: TREASURER, actorCanApprove: true })
  const paid = await server.rolepay.payRuns.execute(ref)
  if (!paid.ok) throw new Error(JSON.stringify(paid.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  expect(paid.value.status).toBe('paid')
  console.log(`run paid from the fee budget: ${NET.explorerUrl}/tx/${paid.value.run.paidTxHash}`)
  expect(await server.testnet.balance(ALPHA_USD, account)).toBe(2_000_000n)
  const key = await server.rolepay.communities.keyStatus({ guildId })
  if (!key.ok) throw new Error(key.error.code)
  expect(key.value.state.remaining).toBe(3_000_000n)
  expect(key.value.state.feeBudgetRemaining).toBeLessThan(500_000n)

  // 6. The payee opens their account page: this browser remembers the passkey account, so the
  // balance shows without a prompt; sending is one prompt, and its fee comes out of AlphaUSD.
  const prompts = await passkeyPrompts(p)
  await p.goto(`${server.url}/account`)
  await expect(p.locator('[data-field="address"]')).toHaveText(account)
  await expect(p.locator('#balances')).toContainText('2 AlphaUSD')
  await p.getByRole('button', { name: 'Max' }).click()
  await expect(p.locator('#amount')).toHaveValue('1.9')
  const destination = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  await p.locator('#to').fill(destination)
  await p.locator('#amount').fill('1')
  await expect(p.locator('[data-field="send-says"]')).toHaveText(`You will send 1 AlphaUSD to ${destination}.`)
  await p.getByRole('button', { name: 'Send with my passkey' }).click()
  await expect(p.locator('#status')).toContainText('Sent 1 AlphaUSD')
  expect(await prompts()).toEqual({ create: 0, get: 1 })
  expect(await server.testnet.balance(ALPHA_USD, destination)).toBe(1_000_000n)
  const left = await server.testnet.balance(ALPHA_USD, account)
  expect(left).toBeLessThan(1_000_000n) // the fee came out of the token sent
  expect(left).toBeGreaterThan(900_000n) // and it was small
  console.log(`payee sent on, unsponsored: ${await p.locator('#status').textContent()}`)

  // 7. The treasurer revokes the key; no sponsor, so the treasury pays that fee too.
  await t.reload()
  await t.getByRole('button', { name: 'Revoke the bot key' }).click()
  await expect(t.locator('#status')).toHaveText('The bot key is revoked.')
  expect(await server.rolepay.communities.keyStatus({ guildId })).toMatchObject({ ok: true, value: { key: { status: 'revoked' }, state: { status: 'revoked' } } })

  // 8. Taking the money back (the end of a pilot): the treasury is the treasurer's passkey account,
  // so the same account page sends what is left wherever the treasurer says.
  await t.goto(`${server.url}/account`)
  await expect(t.locator('[data-field="address"]')).toHaveText(treasury)
  const back = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  await t.locator('#to').fill(back)
  await t.locator('#amount').fill('1')
  await t.getByRole('button', { name: 'Send with my passkey' }).click()
  await expect(t.locator('#status')).toContainText('Sent 1 AlphaUSD')
  expect(await server.testnet.balance(ALPHA_USD, back)).toBe(1_000_000n)

  expect([...treasurer.csp, ...payee.csp]).toEqual([])
})
