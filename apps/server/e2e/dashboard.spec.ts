// Browser end to end for the web dashboard, with no network: sign in with Discord (the fake OAuth
// provider, the real flow: state cookie, PKCE, callback, session cookie), then walk Overview ->
// Runs -> a run -> Policies (the in-memory policy port) -> act as the Treasurer -> Audit log -> CSV.
// No dashboard page may run a script or trip the Content-Security-Policy.
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

test('a treasurer signs in with Discord and walks Overview, Runs, Policies and the Audit log', async ({ page }) => {
  server.oauth.signInAs({ user: { id: TESS.id, name: 'tess_d' }, guilds: [{ id: GUILD, name: 'E2E guild' }] })

  // Sign in.
  await page.goto(`${server.url}/dashboard`)
  await expect(page.getByRole('heading', { name: 'Rolepay dashboard' })).toBeVisible()
  await page.getByRole('link', { name: 'Sign in with Discord' }).click()
  await expect(page.getByRole('heading', { name: 'Your communities' })).toBeVisible()
  expect(server.oauth.exchanges).toEqual([{ code: 'fake-code-1', verifierMatched: true }])
  const session = (await page.context().cookies()).find((c) => c.name === 'rolepay_session')
  expect(session?.httpOnly).toBe(true)
  expect(session?.sameSite).toBe('Lax')

  // Overview.
  await page.getByRole('link', { name: 'E2E guild' }).click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(page.getByText('Tess · Treasurer')).toBeVisible()
  await expect(page.getByText('938 AlphaUSD')).toBeVisible() // 1000 funded, 62 paid
  await expect(page.getByText('38 AlphaUSD left')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Weekly helpers' })).toBeVisible()

  // Keyboard: the first Tab lands on "Skip to content".
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()

  // Runs, then the run.
  await page.getByRole('navigation', { name: 'E2E guild' }).getByRole('link', { name: 'Runs' }).click()
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible()
  await page.getByRole('link', { name: server.runId }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`Run ${server.runId}`) })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Alice' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '50 AlphaUSD' })).toBeVisible()
  await expect(page.getByText('Paid in block')).toBeVisible()
  await expect(page.getByText('Made by a policy')).toBeVisible()

  // Policies: the list, the policy, who it applies to, then an action as the Treasurer.
  await page.getByRole('navigation', { name: 'E2E guild' }).getByRole('link', { name: 'Policies' }).click()
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible()
  await page.getByRole('link', { name: 'Weekly helpers' }).click()
  await expect(page.getByRole('heading', { name: 'Applies to right now' })).toBeVisible()
  await expect(page.getByText('capped at 50')).toBeVisible()
  await page.getByText('Exact filter').click()
  await expect(page.getByText('"repliesIn"')).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByText('Paused. No runs until it is resumed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  expect(server.policies.calls.map((c) => [c.method, c.actor.id])).toEqual([['pause', TESS.id]])

  // Audit log, filtered, and its CSV.
  await page.getByRole('navigation', { name: 'E2E guild' }).getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Paused "Weekly helpers".' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Generated a run of 62 AlphaUSD for 2 people.' })).toBeVisible()
  await page.getByLabel('Event').selectOption('policy.paused')
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('cell', { name: 'Generated a run of 62 AlphaUSD for 2 people.' })).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV' }).click()
  const csv = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of csv) chunks.push(chunk as Buffer)
  const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\r\n')
  expect(lines[0]).toBe('at,type,actor_id,actor_name,policy_id,policy_name,run_id,summary')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('policy.paused')

  // Sign out: the dashboard asks to sign in again.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toBeVisible()
  await page.goto(`${server.url}/dashboard/${GUILD}`)
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toBeVisible()
})
