// Browser end to end on Moderato: a recipient claims with a real passkey; a treasurer creates the
// community account with a passkey as root, funds it, authorises the bot key with the passkey,
// the bot pays a run from that account, the treasurer replaces the key (the old one revoked in the
// same transaction) and revokes the new one with the passkey. Every WebAuthn call is counted: one
// prompt per action, two only when the browser must sign in first.
import { expect, test } from '@playwright/test'
import { createPublicClient, http, toFunctionSelector } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Addresses } from 'viem/tempo'
import { NET, passkeyPrompts, startServer, virtualAuthenticator } from './harness.js'

const PORT = 8799
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

// The pages run under a strict Content-Security-Policy: anything it blocks fails the test.
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

test('a recipient creates a passkey on the claim page, and a returning one signs in with it', async ({ page }) => {
  const guildId = snowflake()
  const dev = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const registered = await server.rolepay.communities.register({ guildId, name: 'E2E guild', treasuryAddress: dev, payoutToken: TOKEN, feeMode: 'sponsor' })
  expect(registered.ok).toBe(true)
  const auth = await virtualAuthenticator(page)

  const first = await server.rolepay.payees.issueLink({ guildId, discordUserId: '200000000000000001' })
  if (!first.ok) throw new Error(first.error.code)
  await page.goto(`${server.url}/claim/${first.value.token}`)
  await expect(page.getByRole('heading', { name: 'Get paid by E2E guild' })).toBeVisible()
  await page.getByRole('button', { name: 'Create my passkey' }).click()
  await expect(page.getByRole('heading', { name: 'You will be paid here' })).toBeVisible()
  const address = (await page.locator('#address').textContent())?.trim() as string
  expect(address).toMatch(/^0x[0-9a-f]{40}$/)
  expect(await auth.credentials()).toHaveLength(1)
  expect(await server.rolepay.payees.get({ guildId, discordUserId: '200000000000000001' })).toMatchObject({ ok: true, value: { address } })

  // The link is spent.
  await page.goto(`${server.url}/claim/${first.value.token}`)
  await expect(page.getByRole('heading', { name: 'This link was already used.' })).toBeVisible()

  // The same person in another link (say another server): signs in with the existing passkey, same account.
  const second = await server.rolepay.payees.issueLink({ guildId, discordUserId: '200000000000000002' })
  if (!second.ok) throw new Error(second.error.code)
  await page.goto(`${server.url}/claim/${second.value.token}`)
  await page.getByRole('button', { name: 'I already have a Rolepay passkey' }).click()
  await expect(page.getByRole('heading', { name: 'You will be paid here' })).toBeVisible()
  expect((await page.locator('#address').textContent())?.trim()).toBe(address)
  expect(await auth.credentials()).toHaveLength(1)
})

test('two payees of one community claiming in the same browser (a shared device) get two passkeys and two addresses', async ({ page }) => {
  const guildId = snowflake()
  const dev = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const registered = await server.rolepay.communities.register({ guildId, name: 'E2E shared guild', treasuryAddress: dev, payoutToken: TOKEN, feeMode: 'sponsor' })
  expect(registered.ok).toBe(true)
  const auth = await virtualAuthenticator(page)
  const claim = async (discordUserId: string, discordUsername: string) => {
    const link = await server.rolepay.payees.issueLink({ guildId, discordUserId, discordUsername })
    if (!link.ok) throw new Error(link.error.code)
    await page.goto(`${server.url}/claim/${link.value.token}`)
    await page.getByRole('button', { name: 'Create my passkey' }).click()
    await expect(page.getByRole('heading', { name: 'You will be paid here' })).toBeVisible()
    return (await page.locator('#address').textContent())?.trim() as string
  }
  // Before the fix both passkeys were "Rolepay: E2E shared guild", and the SDK signed the second
  // person in to the first person's account, so both were paid at one address.
  const alice = await claim('200000000000000001', 'alice')
  const bob = await claim('200000000000000002', 'bob')
  expect(bob).not.toBe(alice)
  expect(await auth.credentials()).toHaveLength(2)
  expect(await server.rolepay.payees.get({ guildId, discordUserId: '200000000000000001' })).toMatchObject({ ok: true, value: { address: alice } })
  expect(await server.rolepay.payees.get({ guildId, discordUserId: '200000000000000002' })).toMatchObject({ ok: true, value: { address: bob } })
})

test('after the server forgets a passkey (its database reset), the browser that still remembers it can create a new one', async ({ page }) => {
  const guildId = snowflake()
  const dev = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const registered = await server.rolepay.communities.register({ guildId, name: 'E2E reset guild', treasuryAddress: dev, payoutToken: TOKEN, feeMode: 'sponsor' })
  expect(registered.ok).toBe(true)
  const auth = await virtualAuthenticator(page)

  const first = await server.rolepay.payees.issueLink({ guildId, discordUserId: '200000000000000001' })
  if (!first.ok) throw new Error(first.error.code)
  await page.goto(`${server.url}/claim/${first.value.token}`)
  await page.getByRole('button', { name: 'Create my passkey' }).click()
  await expect(page.getByRole('heading', { name: 'You will be paid here' })).toBeVisible()
  const address = (await page.locator('#address').textContent())?.trim() as string

  // The server forgets the credential, as a database reset does; the browser's Accounts SDK store
  // still remembers the account under the same passkey name ("Rolepay: E2E reset guild
  // (200000000000000001)": the community and the person, so only that person's next claim meets it).
  const credentials = (await auth.credentials()) as { credentialId: string }[]
  for (const c of credentials) await server.kv.delete(`webauthn:credential:${c.credentialId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`)

  // The same person claims again with a new link. Asked for a new passkey under that name, the SDK
  // first signs in with the remembered one, which the server no longer knows ("Unknown
  // credential"); the page forgets it and registers a new one.
  const second = await server.rolepay.payees.issueLink({ guildId, discordUserId: '200000000000000001' })
  if (!second.ok) throw new Error(second.error.code)
  await page.goto(`${server.url}/claim/${second.value.token}`)
  await page.getByRole('button', { name: 'Create my passkey' }).click()
  await expect(page.getByRole('heading', { name: 'You will be paid here' })).toBeVisible()
  const fresh = (await page.locator('#address').textContent())?.trim() as string
  expect(fresh).toMatch(/^0x[0-9a-f]{40}$/)
  expect(fresh).not.toBe(address)
  expect(await auth.credentials()).toHaveLength(2)
  expect(await server.rolepay.payees.get({ guildId, discordUserId: '200000000000000001' })).toMatchObject({ ok: true, value: { address: fresh } })
})

test('a treasurer creates the treasury with a passkey, authorises the bot key with it, the bot pays, and the passkey revokes it', async ({ page }) => {
  const guildId = snowflake()
  await virtualAuthenticator(page)
  const prompts = await passkeyPrompts(page)
  page.on('dialog', (d) => void d.accept())
  const link = await server.rolepay.communities.issueSetupLink({
    guildId,
    discordUserId: TREASURER,
    settings: { name: 'E2E treasury guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE },
  })
  if (!link.ok) throw new Error(link.error.code)

  // 1. The community account: a new passkey becomes its root.
  await page.goto(`${server.url}/setup/${link.value.token}`)
  await expect(page.getByRole('heading', { name: 'Treasury for E2E treasury guild' })).toBeVisible()
  await page.getByRole('button', { name: 'Create the treasury passkey' }).click()
  await expect(page.locator('#status')).toHaveText('Signed in as the treasury.')
  expect(await prompts()).toEqual({ create: 1, get: 0 })
  const community = await server.rolepay.communities.get(guildId)
  if (!community.ok) throw new Error('not registered')
  const treasury = community.value.treasuryAddress
  expect(community.value).toMatchObject({ name: 'E2E treasury guild', approverRoleId: ROLE, feeMode: 'sponsor' })
  await expect(page.locator('[data-step="fund"] code[data-field="treasury"]')).toHaveText(treasury)

  // 2. Fund it from the testnet faucet.
  await page.getByRole('button', { name: 'Get testnet funds' }).click()
  await expect(page.locator('#status')).toHaveText('Testnet funds arrived.')
  expect(await server.testnet.balance(TOKEN, treasury)).toBeGreaterThan(0n)

  // 3. The bot key: 5 AlphaUSD a day for 2 days, signed with the passkey (sponsored).
  await page.locator('#limit').fill('5')
  await page.locator('#periodDays').fill('1')
  await page.locator('#validityDays').fill('2')
  await expect(page.locator('[data-field="key-prompts"]')).toHaveText('Your device will ask for your passkey once, to sign the key.')
  // The page shows exactly what it will sign, built from the form, not from the server.
  await expect(page.locator('[data-field="key-signs"]')).toContainText('You will sign: Up to 5 AlphaUSD every day. Only transferWithMemo on AlphaUSD')

  // 3a. A server that answers with other numbers (here a limit of 2^255) gets nothing signed.
  await page.route('**/setup/*/key', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { authorization: { limits: { limit: string }[] } }
    ;(body.authorization.limits[0] as { limit: string }).limit = (2n ** 255n).toString()
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: 'Authorise the bot key with my passkey' }).click()
  await expect(page.locator('#status')).toContainText('Nothing was signed')
  expect(await prompts()).toEqual({ create: 1, get: 0 })
  await page.unroute('**/setup/*/key')

  await page.getByRole('button', { name: 'Authorise the bot key with my passkey' }).click()
  await expect(page.locator('#status')).toContainText('The bot key is active')
  // One fingerprint for the authorisation: the root signs one transaction, no separate key signature.
  expect(await prompts()).toEqual({ create: 1, get: 1 })
  const status = await server.rolepay.communities.keyStatus({ guildId })
  expect(status).toMatchObject({ ok: true, value: { key: { status: 'active' }, state: { status: 'active', remaining: 5_000_000n } } })
  if (!status.ok) throw new Error(status.error.code)
  // The call scope on chain: only transferWithMemo on the payout token, to anyone.
  const [isScoped, scopes] = (await createPublicClient({ transport: http(NET.rpcUrl) }).readContract({
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'getAllowedCalls',
    args: [treasury as `0x${string}`, status.value.key.address as `0x${string}`],
  })) as readonly [boolean, readonly { target: string; selectorRules: readonly { selector: string; recipients: readonly string[] }[] }[]]
  expect(isScoped).toBe(true)
  expect(scopes.map((s) => ({ target: s.target.toLowerCase(), selectorRules: s.selectorRules.map((r) => ({ ...r })) }))).toEqual([
    { target: TOKEN, selectorRules: [{ selector: toFunctionSelector('transferWithMemo(address,uint256,bytes32)'), recipients: [] }] },
  ])
  console.log(`passkey-signed authorisation: ${await page.locator('#status').textContent()}`)

  // 4. The bot pays a run from the passkey treasury with its limited key.
  const payee = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const claim = await server.rolepay.payees.issueLink({ guildId, discordUserId: '200000000000000003' })
  if (!claim.ok) throw new Error(claim.error.code)
  expect((await server.rolepay.payees.register({ token: claim.value.token, address: payee })).ok).toBe(true)
  const run = await server.rolepay.payRuns.create({ guildId, createdBy: TREASURER, note: 'e2e', lines: [{ discordUserId: '200000000000000003', amount: 1_500_000n }] })
  if (!run.ok) throw new Error(JSON.stringify(run.error))
  const ref = { guildId, runId: run.value.id }
  await server.rolepay.payRuns.submit({ ...ref, actor: TREASURER })
  await server.rolepay.payRuns.approve({ ...ref, actor: TREASURER, actorCanApprove: true })
  const paid = await server.rolepay.payRuns.execute(ref)
  if (!paid.ok) throw new Error(JSON.stringify(paid.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  expect(paid.value.status).toBe('paid')
  expect(await server.testnet.balance(TOKEN, payee)).toBe(1_500_000n)
  console.log(`run paid from the passkey treasury: ${NET.explorerUrl}/tx/${paid.value.run.paidTxHash}`)
  await page.reload()
  await expect(page.locator('[data-field="key-status"]')).toContainText('3.5 of 5 AlphaUSD left')

  // 5. Replace the key with new limits: still ONE prompt, because the same root transaction revokes
  // the old key and authorises the new one. The old key is revoked on chain, not just in our database.
  const oldKey = status.value.key.address as `0x${string}`
  await page.locator('#limit').fill('4')
  await expect(page.locator('[data-field="key-replaces"]')).toContainText('revokes the current key')
  await page.getByRole('button', { name: 'Replace the bot key with these limits' }).click()
  await expect(page.locator('#status')).toContainText('The bot key is active')
  expect(await prompts()).toEqual({ create: 0, get: 1 })
  const replaced = await server.rolepay.communities.keyStatus({ guildId })
  expect(replaced).toMatchObject({ ok: true, value: { key: { status: 'active' }, state: { status: 'active', remaining: 4_000_000n } } })
  expect(replaced.ok && replaced.value.key.address).not.toBe(oldKey)
  const oldOnChain = (await createPublicClient({ transport: http(NET.rpcUrl) }).readContract({
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'getKey',
    args: [treasury as `0x${string}`, oldKey],
  })) as { isRevoked: boolean }
  expect(oldOnChain.isRevoked).toBe(true)
  await expect(page.locator('#live-keys button')).toHaveCount(1) // only the new key is live
  await page.reload()

  // 6. Revoke with the passkey; the server confirms it from the chain.
  await page.getByRole('button', { name: 'Revoke the bot key' }).click()
  await expect(page.locator('#status')).toHaveText('The bot key is revoked.')
  expect(await prompts()).toEqual({ create: 0, get: 1 })
  expect(await server.rolepay.communities.keyStatus({ guildId })).toMatchObject({ ok: true, value: { key: { status: 'revoked' }, state: { status: 'revoked' } } })

  // 7. This browser forgets the passkey account (site data cleared) while the treasury session
  // is still live: the page must sign in before it can sign, and says so before the click.
  await page.goto(`${server.url}/health`)
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name)
  })
  await page.goto(`${server.url}/setup/${link.value.token}`)
  await expect(page.locator('[data-field="key-prompts"]')).toHaveText('Your device will ask twice: once to sign in, once to sign the key.')
  await page.getByRole('button', { name: 'Authorise the bot key with my passkey' }).click()
  await expect(page.locator('#status')).toContainText('The bot key is active')
  expect(await prompts()).toEqual({ create: 0, get: 2 })
})

test('a treasurer turns on preferred stablecoins: the passkey signs a key with the swap scope in one prompt, and the bot pays a payee in BetaUSD', async ({ page }) => {
  const BETA = '0x20c0000000000000000000000000000000000002'
  const THETA = '0x20c0000000000000000000000000000000000003'
  const DEX = '0xdec0000000000000000000000000000000000000'
  const guildId = snowflake()
  await virtualAuthenticator(page)
  const prompts = await passkeyPrompts(page)
  const link = await server.rolepay.communities.issueSetupLink({
    guildId,
    discordUserId: TREASURER,
    settings: { name: 'E2E preferred guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE },
  })
  if (!link.ok) throw new Error(link.error.code)
  await page.goto(`${server.url}/setup/${link.value.token}`)
  await page.getByRole('button', { name: 'Create the treasury passkey' }).click()
  await expect(page.locator('#status')).toHaveText('Signed in as the treasury.')
  await page.getByRole('button', { name: 'Get testnet funds' }).click()
  await expect(page.locator('#status')).toHaveText('Testnet funds arrived.')
  const community = await server.rolepay.communities.get(guildId)
  if (!community.ok) throw new Error('not registered')
  const treasury = community.value.treasuryAddress

  // Off by default: the page would sign exactly the old authorisation.
  await expect(page.locator('[data-field="preferred-status"]')).toHaveText('Off: everyone is paid in AlphaUSD.')
  await expect(page.locator('[data-field="key-signs"]')).not.toContainText('swapExactAmountOut')
  // On: no prompt (nothing changes on chain), and the authorisation the page builds gains the swap scope.
  await page.getByLabel('Pay each person in the stablecoin they prefer').check()
  await expect(page.locator('#status')).toHaveText('Preferred stablecoins are on. Authorise a new bot key below so it can swap.')
  await expect(page.locator('[data-field="preferred-status"]')).toContainText('the current bot key cannot swap')
  expect(await prompts()).toEqual({ create: 1, get: 0 })
  await page.locator('#limit').fill('5')
  await page.locator('#periodDays').fill('1')
  await page.locator('#validityDays').fill('2')
  await expect(page.locator('[data-field="key-signs"]')).toContainText("Only swapExactAmountOut on Tempo's stablecoin exchange")
  await expect(page.locator('[data-field="key-signs"]')).toContainText('plus up to 5 BetaUSD and up to 5 ThetaUSD every day to pay people who chose them')
  await page.getByRole('button', { name: 'Authorise the bot key with my passkey' }).click()
  await expect(page.locator('#status')).toContainText('The bot key is active')
  // One prompt for the key, the swap scope included (counts are per page load: the treasury passkey, then this signature).
  expect(await prompts()).toEqual({ create: 1, get: 1 })
  await expect(page.locator('[data-field="preferred-status"]')).toContainText('On: people who chose another stablecoin get it')

  // The scope on chain: transferWithMemo on AlphaUSD, the exact-output swap, transferWithMemo on BetaUSD and ThetaUSD.
  const status = await server.rolepay.communities.keyStatus({ guildId })
  if (!status.ok) throw new Error(status.error.code)
  const [, scopes] = (await createPublicClient({ transport: http(NET.rpcUrl) }).readContract({
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'getAllowedCalls',
    args: [treasury as `0x${string}`, status.value.key.address as `0x${string}`],
  })) as readonly [boolean, readonly { target: string; selectorRules: readonly { selector: string }[] }[]]
  expect(scopes.map((s) => [s.target.toLowerCase(), s.selectorRules.map((r) => r.selector)])).toEqual([
    [TOKEN, [toFunctionSelector('transferWithMemo(address,uint256,bytes32)')]],
    [DEX, [toFunctionSelector('swapExactAmountOut(address,address,uint128,uint128)')]],
    [BETA, [toFunctionSelector('transferWithMemo(address,uint256,bytes32)')]],
    [THETA, [toFunctionSelector('transferWithMemo(address,uint256,bytes32)')]],
  ])

  // A payee who chose BetaUSD is paid in it, in one transaction from the passkey treasury.
  const payee = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const claim = await server.rolepay.payees.issueLink({ guildId, discordUserId: '200000000000000004' })
  if (!claim.ok) throw new Error(claim.error.code)
  await server.rolepay.payees.register({ token: claim.value.token, address: payee })
  await server.rolepay.payees.setPreferredToken({ guildId, discordUserId: '200000000000000004', token: BETA })
  const run = await server.rolepay.payRuns.create({ guildId, createdBy: TREASURER, note: 'e2e preferred', lines: [{ discordUserId: '200000000000000004', amount: 1_000_000n }] })
  if (!run.ok) throw new Error(JSON.stringify(run.error))
  const ref = { guildId, runId: run.value.id }
  await server.rolepay.payRuns.submit({ ...ref, actor: TREASURER })
  await server.rolepay.payRuns.approve({ ...ref, actor: TREASURER, actorCanApprove: true })
  const paid = await server.rolepay.payRuns.execute(ref)
  if (!paid.ok) throw new Error(JSON.stringify(paid.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  expect(paid.value.status).toBe('paid')
  expect(await server.testnet.balance(BETA, payee)).toBe(1_000_000n)
  expect(await server.testnet.balance(TOKEN, payee)).toBe(0n)
  console.log(`paid in BetaUSD from the passkey treasury: ${NET.explorerUrl}/tx/${paid.value.run.paidTxHash}`)
})
