// Browser end to end on Moderato: the treasurer sets up deposit addresses on the treasury page. The
// page mines the registration salt in Web Workers (WebAssembly, allowed by the setup page's CSP
// alone), builds registerVirtualMaster(salt) itself, checks the server's copy, and the passkey signs
// it: one prompt. A server that answers with another call gets nothing signed. Then a funding source,
// a real deposit to its address from a faucet-funded account, and the watcher attributes it.
import { expect, test } from '@playwright/test'
import { generatePrivateKey } from 'viem/accounts'
import { Abis, Account, Actions, createClient, http, withRelay } from 'viem/tempo'
import { NET, passkeyPrompts, startServer, virtualAuthenticator } from './harness.js'

const PORT = 8796
const TOKEN = '0x20c0000000000000000000000000000000000001' // AlphaUSD
const ROLE = '400000000000000001'
const TREASURER = '300000000000000001'
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

test('the treasury sets up deposit addresses with one passkey prompt; a deposit lands in it and is attributed to its source', async ({ page }) => {
  test.setTimeout(900_000)
  const guildId = snowflake()
  await virtualAuthenticator(page)
  const prompts = await passkeyPrompts(page)
  const link = await server.rolepay.communities.issueSetupLink({
    guildId,
    discordUserId: TREASURER,
    settings: { name: 'E2E funding guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE },
  })
  if (!link.ok) throw new Error(link.error.code)

  // 1. The treasury passkey.
  await page.goto(`${server.url}/setup/${link.value.token}`)
  await page.getByRole('button', { name: 'Create the treasury passkey' }).click()
  await expect(page.locator('#status')).toHaveText('Signed in as the treasury.')
  const community = await server.rolepay.communities.get(guildId)
  if (!community.ok) throw new Error('not registered')
  const treasury = community.value.treasuryAddress
  await expect(page.getByRole('heading', { name: '4. Deposit addresses' })).toBeVisible()
  await expect(page.locator('[data-field="deposits-status"]')).toHaveText('Not set up yet.')

  // 2a. A server that answers with another call (here another salt) gets nothing signed.
  await page.route('**/setup/*/deposits/plan', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { call: { data: string } }
    body.call.data = `${body.call.data.slice(0, -2)}${body.call.data.endsWith('00') ? '01' : '00'}`
    await route.fulfill({ response, json: body })
  })
  const started = Date.now()
  await page.getByRole('button', { name: 'Set up deposit addresses' }).click()
  await expect(page.locator('#status')).toContainText('Nothing was signed', { timeout: 600_000 })
  console.log(`first salt mined in the browser in ${Math.round((Date.now() - started) / 1000)} s`)
  expect(await prompts()).toEqual({ create: 1, get: 0 })
  await page.unroute('**/setup/*/deposits/plan')

  // 2b. The real thing: mined again, checked, one passkey signature, recorded from the chain.
  const again = Date.now()
  await page.getByRole('button', { name: 'Set up deposit addresses' }).click()
  await expect(page.locator('#status')).toContainText('Deposit addresses are set up', { timeout: 600_000 })
  console.log(`set up in ${Math.round((Date.now() - again) / 1000)} s: ${await page.locator('#status').textContent()}`)
  expect(await prompts()).toEqual({ create: 1, get: 1 })
  const status = await server.rolepay.funding.status({ guildId })
  if (!status.ok || !status.value.master) throw new Error('no master recorded')
  const master = status.value.master
  await expect(page.locator('[data-field="deposits-status"]')).toContainText(`start with ${master.masterId}`)
  const reader = createClient({ testnet: true, transport: http(NET.rpcUrl) })
  expect((await Actions.virtualAddress.getMasterAddress(reader, { masterId: master.masterId }))?.toLowerCase()).toBe(treasury)

  // 3. A funding source, and 1.5 AlphaUSD to its address from someone who knows nothing about Rolepay.
  const source = await server.rolepay.funding.createSource({ guildId, actor: TREASURER, actorRoleIds: [ROLE], name: 'Judges pool' })
  if (!source.ok) throw new Error(source.error.code)
  const funder = Account.fromSecp256k1(generatePrivateKey())
  await server.testnet.ensureFunded(funder.address, TOKEN, 2_000_000n)
  const before = await server.testnet.balance(TOKEN, treasury)
  const sender = createClient({ account: funder, testnet: true, transport: withRelay(http(NET.rpcUrl), http(NET.sponsorUrl)) })
  const receipt = await sender.writeContractSync({
    address: TOKEN,
    abi: Abis.tip20,
    functionName: 'transfer',
    args: [source.value.depositAddress, 1_500_000n],
    feePayer: true,
    validBefore: Math.floor(Date.now() / 1000) + 120,
    throwOnReceiptRevert: true,
  } as never)
  expect((await server.testnet.balance(TOKEN, treasury)) - before).toBe(1_500_000n)
  const scanned = await server.rolepay.funding.scan()
  expect(scanned.deposits.map((d) => [d.sourceId, d.amount, d.txHash])).toEqual([[source.value.id, 1_500_000n, (receipt as { transactionHash: string }).transactionHash.toLowerCase()]])
  console.log(`deposit attributed: ${NET.explorerUrl}/tx/${(receipt as { transactionHash: string }).transactionHash}`)
})
