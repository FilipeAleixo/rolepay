import { describe, expect, it } from 'vitest'
import type { CriteriaProposalRequest, MessageProposalRequest } from '../../ports/runProposer.js'
import { FakeRunProposer } from '../memory/fakeProposer.js'
import { MemoryKeyValueStore } from '../memory/keyValue.js'
import { ManualClock } from '../memory/support.js'
import { DailyCappedProposer } from './proposerDailyCap.js'

const MESSAGES: MessageProposalRequest = { instruction: '50 each', messages: [], token: 'AlphaUSD', remaining: null, maxLines: 50 }
const CRITERIA: CriteriaProposalRequest = { instruction: 'pay 1 to every Mod', today: '2026-10-07', maxLookbackDays: 31, roles: [], channels: [], token: 'AlphaUSD', remaining: null }

function world(cap: number) {
  const clock = new ManualClock(new Date('2026-10-07T23:00:00.000Z'))
  const kv = new MemoryKeyValueStore(clock)
  const inner = new FakeRunProposer()
  return { clock, kv, inner, capped: new DailyCappedProposer(inner, { cap, kv, clock }) }
}

describe('DailyCappedProposer (a server-wide cap on model calls per UTC day)', () => {
  it('lets `cap` calls through across both modes, then answers daily_cap without calling the model', async () => {
    const w = world(3)
    expect(w.capped.model).toBe('fake-proposer')
    expect((await w.capped.fromMessages(MESSAGES)).ok).toBe(true)
    expect((await w.capped.fromCriteria(CRITERIA)).ok).toBe(true)
    expect((await w.capped.fromMessages(MESSAGES)).ok).toBe(true)
    expect(w.inner.requests).toHaveLength(3)

    const refused = await w.capped.fromCriteria(CRITERIA)
    expect(refused).toEqual({ ok: false, error: { code: 'could_not_propose', reason: 'daily_cap', detail: 'daily cap of 3 model calls reached', usage: null } })
    expect((await w.capped.fromMessages(MESSAGES)).ok).toBe(false)
    expect(w.inner.requests).toHaveLength(3)
  })

  it('counts calls the model failed: they are billed too', async () => {
    const w = world(1)
    w.inner.onMessages = () => ({ code: 'could_not_propose', reason: 'unavailable', detail: 'HTTP 529', usage: null })
    expect(await w.capped.fromMessages(MESSAGES)).toMatchObject({ ok: false, error: { reason: 'unavailable' } })
    expect(await w.capped.fromMessages(MESSAGES)).toMatchObject({ ok: false, error: { reason: 'daily_cap' } })
    expect(w.inner.requests).toHaveLength(1)
  })

  it('starts a fresh count at midnight UTC', async () => {
    const w = world(1)
    expect((await w.capped.fromMessages(MESSAGES)).ok).toBe(true)
    expect(await w.capped.fromMessages(MESSAGES)).toMatchObject({ error: { reason: 'daily_cap' } })
    w.clock.advance(3600) // 2026-10-08T00:00Z
    expect((await w.capped.fromMessages(MESSAGES)).ok).toBe(true)
    expect(w.inner.requests).toHaveLength(2)
  })

  it('keeps the count in the store, so a restarted process does not get a fresh budget', async () => {
    const w = world(2)
    expect((await w.capped.fromMessages(MESSAGES)).ok).toBe(true)
    const restarted = new DailyCappedProposer(w.inner, { cap: 2, kv: w.kv, clock: w.clock })
    expect((await restarted.fromMessages(MESSAGES)).ok).toBe(true)
    expect(await restarted.fromMessages(MESSAGES)).toMatchObject({ error: { reason: 'daily_cap' } })
    expect(await w.capped.fromMessages(MESSAGES)).toMatchObject({ error: { reason: 'daily_cap' } })
    expect(w.inner.requests).toHaveLength(2)
  })

  it('calls at the same moment never pass the cap together', async () => {
    const w = world(5)
    const other = new DailyCappedProposer(w.inner, { cap: 5, kv: w.kv, clock: w.clock })
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? other : w.capped).fromMessages(MESSAGES)))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(w.inner.requests).toHaveLength(5)
  })
})
