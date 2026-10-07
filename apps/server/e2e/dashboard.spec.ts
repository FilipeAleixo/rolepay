// Browser end to end for the web dashboard, with no network: sign in with Discord (the fake OAuth
// provider, the real flow: state cookie, PKCE, callback, session cookie), then walk Overview ->
// Runs -> a run -> Policies (core's real policy services on memory adapters, through the policy
// seam) -> pause as the Treasurer -> veto an autopilot run -> write and approve a policy from the
// web -> Funding (a source's deposit address and QR code, its deposit, a new source from the web)
// -> Audit log -> CSV -> sign out. No dashboard page may run a script or trip the
// Content-Security-Policy.
import { expect, test } from '@playwright/test'
import { GUILD, TESS, startDashboardServer } from './dashboardServer.js'

const PORT = 8797

let server: Awaited<ReturnType<typeof startDashboardServer>>
test.beforeAll(async () => {
  server = await startDashboardServer(PORT)
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

test('a treasurer signs in with Discord and walks Overview, Runs, Policies (pause, veto, a new policy), Funding (a new source) and the Audit log', async ({ page }) => {
  server.oauth.signInAs({ user: { id: TESS.id, name: 'tess_d' }, guilds: [{ id: GUILD, name: 'E2E guild' }] })
  const nav = () => page.getByRole('navigation', { name: 'E2E guild' })

  // Sign in.
  await page.goto(`${server.url}/dashboard`)
  await expect(page.getByRole('heading', { name: 'Rolepay dashboard' })).toBeVisible()
  await page.getByRole('link', { name: 'Sign in with Discord' }).click()
  await expect(page.getByRole('heading', { name: 'Your communities' })).toBeVisible()
  expect(server.oauth.exchanges).toEqual([{ code: 'fake-code-1', verifierMatched: true }])
  const session = (await page.context().cookies()).find((c) => c.name === 'rolepay_session')
  expect(session?.httpOnly).toBe(true)
  expect(session?.sameSite).toBe('Lax')

  // Overview: the treasury after the policy's paid run, the key's budget, the policies' next runs.
  await page.getByRole('link', { name: 'E2E guild' }).click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(page.getByText('Tess · Treasurer')).toBeVisible()
  await expect(page.getByText('938 AlphaUSD')).toBeVisible() // 1000 funded, 62 paid
  await expect(page.getByText('138 AlphaUSD left')).toBeVisible() // a key of 200
  // At a glance: the budget as a bar, and this week's policy run in the weekly chart (one drawing shown at this width).
  await expect(page.getByRole('img', { name: /^Bot key budget: 62 of 200 AlphaUSD spent, 138 AlphaUSD left\./ })).toBeVisible()
  await expect(page.getByRole('img', { name: /^Paid per week for the last 12 weeks: 62 AlphaUSD in all, 62 by a policy and 0 by hand\./ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Weekly helpers' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Autopilot helpers' })).toBeVisible()
  // Funded this month, through the deposit address of one funding source.
  await expect(page.getByRole('heading', { name: 'Funded this month' })).toBeVisible()
  await expect(page.getByText('from 1 source, since')).toBeVisible()

  // Keyboard: the first Tab lands on "Skip to content".
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()

  // Runs, then the run the policy made and Tess paid.
  await nav().getByRole('link', { name: 'Runs' }).click()
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible()
  await page.getByRole('link', { name: server.runId }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`Run ${server.runId}`) })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Alice' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '50 AlphaUSD' })).toBeVisible()
  await expect(page.getByText('Paid in block')).toBeVisible()
  await expect(page.getByText('Made by a policy')).toBeVisible()

  // Policies: the list, the policy, who it applies to (from this week's activity), then a pause.
  await nav().getByRole('link', { name: 'Policies' }).click()
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible()
  await page.getByRole('link', { name: 'Weekly helpers' }).click()
  await expect(page.getByRole('heading', { name: 'Applies to right now' })).toBeVisible()
  await expect(page.getByText('capped at 50 AlphaUSD')).toBeVisible()
  await expect(page.getByText('Who: has @Mods')).toBeVisible()
  await page.getByText('Exact filter').click()
  await expect(page.getByText('"repliesIn"')).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByText('Paused. No runs until it is resumed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  const paused = await server.rolepay.policies.get({ guildId: GUILD, policyId: server.policyId })
  expect(paused.ok && paused.value.status).toBe('paused')

  // The autopilot run, inside its veto window: Tess vetoes it, nothing is paid.
  await nav().getByRole('link', { name: 'Runs' }).click()
  await page.getByRole('link', { name: server.autopilotRunId }).click()
  await expect(page.getByText(/pays at .* unless vetoed/)).toBeVisible()
  await page.getByRole('button', { name: 'Veto this run' }).click()
  await expect(page.getByText('Vetoed. This run is cancelled and nothing will be paid for it.')).toBeVisible()
  await expect(page.getByText(/Vetoed by Tess/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Veto this run' })).toHaveCount(0)
  const vetoed = await server.rolepay.payRuns.get({ guildId: GUILD, runId: server.autopilotRunId })
  expect(vetoed.ok && vetoed.value.status).toBe('cancelled')

  // A new policy from the web: compiled once by the (scripted) model into a draft, then approved.
  await nav().getByRole('link', { name: 'Policies' }).click()
  await page.getByRole('link', { name: 'New policy' }).click()
  await page.getByLabel('Name').fill('Web bounties')
  await page.getByLabel('Instruction').fill('Every Monday: 2 USDC per answered question in #help, max 50 a week each.')
  await page.getByLabel('Hour (0-23)').fill('9')
  await page.getByRole('button', { name: 'Compile and preview' }).click()
  await expect(page.getByText('Created as a draft.')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Web bounties/ })).toBeVisible()
  await expect(page.getByRole('cell', { name: '24 AlphaUSD' })).toBeVisible() // Alice: 12 answers at 2 each
  await page.getByRole('button', { name: 'Approve version 1' }).click()
  await expect(page.getByText('Approved.', { exact: true })).toBeVisible()
  expect(server.proposer.requests).toHaveLength(3)

  // Funding: the source's deposit address with its QR code, its deposit with the transaction, then a new source.
  await nav().getByRole('link', { name: 'Funding' }).click()
  await expect(page.getByRole('heading', { name: 'Funding', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Acme DAO' })).toBeVisible()
  await expect(page.getByText(server.deposit.address, { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: `QR code of the deposit address ${server.deposit.address}` })).toBeVisible()
  await expect(page.getByRole('cell', { name: '25 AlphaUSD' })).toBeVisible()
  await expect(page.locator(`a[href$="/tx/${server.deposit.txHash}"]`)).toBeVisible()
  await page.getByLabel('Name').fill('Judges pool')
  await page.getByRole('button', { name: 'Create its deposit address' }).click()
  await expect(page.getByText('Funding source created.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Judges pool' })).toBeVisible()
  await expect(page.getByText('0x58e21090fdfdfdfdfdfdfdfdfdfd000000000002', { exact: true })).toBeVisible()

  // Audit log, filtered, and its CSV.
  await nav().getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Paused it: no runs until it is resumed.' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Vetoed the run of 62 AlphaUSD for 2 people: nothing is paid.' })).toBeVisible()
  await expect(page.getByRole('cell', { name: /^Received 25 AlphaUSD at the deposit address of funding source fsrc_/ })).toBeVisible()
  await page.getByLabel('Event').selectOption('policy.paused')
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('cell', { name: 'Vetoed the run of 62 AlphaUSD for 2 people: nothing is paid.' })).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV' }).click()
  const csv = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of csv) chunks.push(chunk as Buffer)
  const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\r\n')
  expect(lines[0]).toBe('at,type,actor_id,actor_name,policy_id,policy_name,run_id,summary')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain(`,policy.paused,${TESS.id},Tess,${server.policyId},Weekly helpers,`)

  // Sign out: the dashboard asks to sign in again.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toBeVisible()
  await page.goto(`${server.url}/dashboard/${GUILD}`)
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toBeVisible()
})
