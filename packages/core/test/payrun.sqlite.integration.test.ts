// Service level on a real SQLite file (fake chain): the compare-and-set and the crash
// recovery hold on the production repositories, not only on the in-memory fakes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FakePayoutChain, ManualClock, PlainKeyVault, RandomIds, openSqliteDatabase } from '../src/adapters/index.js'
import { type Payrun, type Run, createPayrun } from '../src/index.js'
import type { RunRepository } from '../src/ports/repositories.js'

const GUILD = '1094309218049937418'
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const USERS = ['200000000000000001', '200000000000000002'] as const
const ADDRS = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'] as const

const dir = mkdtempSync(join(tmpdir(), 'payrun-svc-sqlite-'))
const toClose: { close(): Promise<void> }[] = []
afterAll(async () => {
  for (const d of toClose) await d.close()
  rmSync(dir, { recursive: true, force: true })
})

class CrashingRuns implements RunRepository {
  crashOn: ((next: Run) => boolean) | null = null
  constructor(private readonly inner: RunRepository) {}
  insert = (r: Run) => this.inner.insert(r)
  get = (id: string) => this.inner.get(id)
  listByCommunity = (c: string, o?: { limit?: number }) => this.inner.listByCommunity(c, o)
  listByStatus = (s: Run['status']) => this.inner.listByStatus(s)
  async update(next: Run) {
    if (this.crashOn?.(next)) {
      this.crashOn = null
      throw new Error('simulated crash')
    }
    return this.inner.update(next)
  }
}

describe('PayRunService on SQLite', () => {
  let chain: FakePayoutChain
  let path: string
  let runs: CrashingRuns
  let payrun: Payrun
  let n = 0

  const compose = async (wrap = false) => {
    const db = await openSqliteDatabase(path)
    toClose.push(db)
    const clock = new ManualClock()
    if (wrap) runs = new CrashingRuns(db.repositories.runs)
    return createPayrun({
      chain,
      repositories: { ...db.repositories, runs: wrap ? runs : db.repositories.runs },
      vault: new PlainKeyVault(),
      ids: new RandomIds(),
      clock,
      network: 'moderato',
    })
  }

  beforeEach(async () => {
    path = join(dir, `svc${++n}.db`)
    chain = new FakePayoutChain({ startTime: Math.floor(new ManualClock().now().getTime() / 1000) })
    chain.fund(TOKEN, TREASURY, 100_000_000n)
    payrun = await compose(true)
    await payrun.communities.register({ guildId: GUILD, name: 'g', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
    await payrun.communities.provisionBotKey({ guildId: GUILD, limit: 50_000_000n, expiresAt: chain.time + 86_400 })
    await payrun.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    for (const [i, user] of USERS.entries()) {
      const link = await payrun.payees.issueLink({ guildId: GUILD, discordUserId: user })
      if (!link.ok) throw new Error()
      await payrun.payees.register({ token: link.value.token, address: ADDRS[i] as string })
    }
  })

  async function approved() {
    const r = await payrun.payRuns.create({ guildId: GUILD, createdBy: USERS[0], note: null, lines: USERS.map((u) => ({ discordUserId: u, amount: 1_000_000n })) })
    if (!r.ok) throw new Error(r.error.code)
    await payrun.payRuns.submit({ guildId: GUILD, runId: r.value.id, actor: USERS[0] })
    await payrun.payRuns.approve({ guildId: GUILD, runId: r.value.id, actor: '300000000000000001', actorCanApprove: true })
    return r.value.id
  }

  it('two concurrent executes on the same database broadcast once', async () => {
    const id = await approved()
    const results = await Promise.all([payrun.payRuns.execute({ guildId: GUILD, runId: id }), payrun.payRuns.execute({ guildId: GUILD, runId: id })])
    expect(results.filter((r) => r.ok && r.value.status === 'paid')).toHaveLength(1)
    expect(chain.landedTxCount).toBe(1)
    expect(chain.balance(TOKEN, ADDRS[0])).toBe(1_000_000n)
  })

  it('a crash after landing is recovered by a process that reopens the file, with one payment', async () => {
    const id = await approved()
    runs.crashOn = (next) => next.status === 'paid'
    await expect(payrun.payRuns.execute({ guildId: GUILD, runId: id })).rejects.toThrow('simulated crash')
    const restarted = await compose()
    expect(await restarted.payRuns.recoverInFlight()).toEqual([{ runId: id, status: 'paid' }])
    expect(await restarted.payRuns.execute({ guildId: GUILD, runId: id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(chain.landedTxCount).toBe(1)
    expect(chain.balance(TOKEN, ADDRS[1])).toBe(1_000_000n)
  })
})
