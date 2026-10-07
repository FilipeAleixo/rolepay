// Browser end to end on Moderato: a standing policy gets its own budget on the treasury page. The
// treasurer creates the treasury with a passkey and authorises the bot key (as passkeys.spec.ts
// does), then opens the policy's page: the page shows what it will sign for this policy only, signs
// nothing when the server's answer is tampered with, and gives the policy its own key with ONE
// passkey prompt. The policy's run is paid with that key (the bot key untouched), and the passkey
// revokes it with one more prompt, leaving the bot key active. Every WebAuthn call is counted.
import { expect, test } from '@playwright/test'
import { FakeActivityReader, FakeRunProposer, emptyCriteria } from '@rolepay/core/adapters'
import { createPublicClient, http, toFunctionSelector } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Addresses } from 'viem/tempo'
import { NET, passkeyPrompts, startServer, virtualAuthenticator } from './harness.js'

const PORT = 8801
const TOKEN = '0x20c0000000000000000000000000000000000001' // AlphaUSD
const ROLE = '400000000000000001'
const MODS = '400000000000000002'
const TREASURER = '300000000000000001'
const JUDGE = '200000000000000041'
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)

const proposer = new FakeRunProposer()
const activity = new FakeActivityReader()
let server: Awaited<ReturnType<typeof startServer>>
test.beforeAll(async () => {
  server = await startServer(PORT, {}, { proposer, activity })
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

const keychain = () => createPublicClient({ transport: http(NET.rpcUrl) })

test("a treasurer gives a policy its own budget with one passkey prompt; its run is paid with that key; the passkey revokes it and the bot key stays", async ({ page }) => {
  const guildId = snowflake()
  await virtualAuthenticator(page)
  const prompts = await passkeyPrompts(page)
  page.on('dialog', (d) => void d.accept())
  const link = await server.rolepay.communities.issueSetupLink({ guildId, discordUserId: TREASURER, settings: { name: 'E2E policy budget guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE } })
  if (!link.ok) throw new Error(link.error.code)

  // 1. The treasury and the bot key (5 AlphaUSD a day), as on the setup page.
  await page.goto(`${server.url}/setup/${link.value.token}`)
  await page.getByRole('button', { name: 'Create the treasury passkey' }).click()
  await expect(page.locator('#status')).toHaveText('Signed in as the treasury.')
  await page.getByRole('button', { name: 'Get testnet funds' }).click()
  await expect(page.locator('#status')).toHaveText('Testnet funds arrived.')
  await page.locator('#limit').fill('5')
  await page.locator('#periodDays').fill('1')
  await page.locator('#validityDays').fill('2')
  await page.getByRole('button', { name: 'Authorise the bot key with my passkey' }).click()
  await expect(page.locator('#status')).toContainText('The bot key is active')
  const bot = await server.rolepay.communities.keyStatus({ guildId })
  if (!bot.ok) throw new Error(bot.error.code)
  const community = await server.rolepay.communities.get(guildId)
  if (!community.ok) throw new Error(community.error.code)
  const treasury = community.value.treasuryAddress

  // 2. A standing policy (written by the scripted model): 1 AlphaUSD to every Mod, daily; approved.
  const who = { guildId, actor: TREASURER, actorRoleIds: [ROLE] }
  await server.rolepay.communities.setAiProposals({ guildId, enabled: true, actorRoleIds: [ROLE] })
  activity.roles = [{ id: MODS, name: 'Mods' }]
  activity.setMember(JUDGE, { roleIds: [MODS], joinedAt: null })
  proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' }, note: 'Judges' }, { hasRole: ['R1'] })
  const created = await server.rolepay.policies.create({ ...who, name: 'Judges', instruction: '1 AlphaUSD to every Mod each Monday', schedule: { kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'UTC' }, caps: { perRun: 2_000_000n, perPerson: null } })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  const policyId = created.value.id
  expect((await server.rolepay.policies.approve({ ...who, policyId, version: 1 })).ok).toBe(true)

  // 3. The policy's budget page: it pays from the bot key so far; the form starts from the policy's cap per run and its week.
  await page.goto(`${server.url}/setup/${link.value.token}/policies/${policyId}`)
  await expect(page.getByRole('heading', { name: 'A budget of its own for Judges' })).toBeVisible()
  await expect(page.locator('[data-field="budget-status"]')).toContainText("pays from the bot key's budget")
  await expect(page.locator('#limit')).toHaveValue('2')
  await expect(page.locator('#periodDays')).toHaveValue('7')
  await page.locator('#periodDays').fill('1')
  await page.locator('#validityDays').fill('2')
  await expect(page.locator('[data-field="key-signs"]')).toContainText('You will sign, for this policy only: Up to 2 AlphaUSD every day. Only transferWithMemo on AlphaUSD')
  await expect(page.locator('[data-field="key-prompts"]')).toHaveText('Your device will ask for your passkey once, to sign the key.')

  // 3a. A server that answers with a bigger limit gets nothing signed, and no passkey prompt.
  await page.route('**/policies/*/key', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { authorization: { limits: { limit: string }[] } }
    ;(body.authorization.limits[0] as { limit: string }).limit = (2n ** 255n).toString()
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: 'Give this policy its own budget' }).click()
  await expect(page.locator('#status')).toContainText('Nothing was signed')
  expect(await prompts()).toEqual({ create: 0, get: 0 })
  await page.unroute('**/policies/*/key')

  // 3b. Signed as typed: one passkey prompt, one transaction from the root.
  await page.getByRole('button', { name: 'Give this policy its own budget' }).click()
  await expect(page.locator('#status')).toContainText('Judges has its own budget now.')
  expect(await prompts()).toEqual({ create: 0, get: 1 })
  console.log(`policy key authorised with the passkey: ${await page.locator('#status').textContent()}`)
  const own = await server.rolepay.policyKeys.status({ guildId, policyId })
  expect(own).toMatchObject({ ok: true, value: { signs: 'own', key: { status: 'active' }, state: { status: 'active', remaining: 2_000_000n } } })
  if (!own.ok || !own.value.key) throw new Error('no policy key')
  const policyKey = own.value.key.address as `0x${string}`
  // Its call scope on chain: only transferWithMemo on the payout token, like the bot key.
  const [isScoped, scopes] = (await keychain().readContract({ address: Addresses.accountKeychain, abi: Abis.accountKeychain, functionName: 'getAllowedCalls', args: [treasury as `0x${string}`, policyKey] })) as readonly [
    boolean,
    readonly { target: string; selectorRules: readonly { selector: string; recipients: readonly string[] }[] }[],
  ]
  expect(isScoped).toBe(true)
  expect(scopes.map((s) => ({ target: s.target.toLowerCase(), selectorRules: s.selectorRules.map((r) => ({ ...r })) }))).toEqual([
    { target: TOKEN, selectorRules: [{ selector: toFunctionSelector('transferWithMemo(address,uint256,bytes32)'), recipients: [] }] },
  ])
  await expect(page.locator('[data-field="budget-status"]')).toContainText('2 of 2 AlphaUSD left')

  // 4. The policy's run is paid with its own key; the bot key keeps its 5.
  const judge = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const claim = await server.rolepay.payees.issueLink({ guildId, discordUserId: JUDGE })
  if (!claim.ok) throw new Error(claim.error.code)
  expect((await server.rolepay.payees.register({ token: claim.value.token, address: judge })).ok).toBe(true)
  const made = await server.rolepay.scheduler.runNow({ ...who, policyId })
  if (!made.ok || !made.value.run) throw new Error(JSON.stringify(made.ok ? made.value.policyRun.hold : made.error))
  const ref = { guildId, runId: made.value.run.id }
  await server.rolepay.payRuns.approve({ ...ref, actor: TREASURER, actorCanApprove: true })
  const paid = await server.rolepay.payRuns.execute(ref)
  if (!paid.ok || paid.value.status !== 'paid') throw new Error(JSON.stringify(paid, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  console.log(`policy run paid with its own key: ${NET.explorerUrl}/tx/${paid.value.run.paidTxHash}`)
  expect(await server.testnet.balance(TOKEN, judge)).toBe(1_000_000n)
  expect(await server.rolepay.policyKeys.budget({ guildId, policyId })).toEqual({ key: 'policy', remaining: 1_000_000n })
  expect(await server.rolepay.communities.keyStatus({ guildId })).toMatchObject({ ok: true, value: { state: { remaining: 5_000_000n } } })
  await page.reload()
  await expect(page.locator('[data-field="budget-status"]')).toContainText('1 of 2 AlphaUSD left')

  // 5. The passkey revokes the policy's key (one prompt). The bot key stays active on chain.
  await page.getByRole('button', { name: "Revoke this policy's key" }).click()
  await expect(page.locator('#status')).toHaveText("This policy's key is revoked.")
  expect(await prompts()).toEqual({ create: 0, get: 1 })
  expect(await server.rolepay.policyKeys.status({ guildId, policyId })).toMatchObject({ ok: true, value: { signs: 'retired' } })
  const onChain = (await keychain().readContract({ address: Addresses.accountKeychain, abi: Abis.accountKeychain, functionName: 'getKey', args: [treasury as `0x${string}`, policyKey] })) as { isRevoked: boolean }
  expect(onChain.isRevoked).toBe(true)
  expect(await server.rolepay.communities.keyStatus({ guildId })).toMatchObject({ ok: true, value: { key: { address: bot.value.key.address, status: 'active' }, state: { status: 'active' } } })
  await expect(page.locator('[data-field="budget-status"]')).toContainText('It never falls back to the bot key.')
})
