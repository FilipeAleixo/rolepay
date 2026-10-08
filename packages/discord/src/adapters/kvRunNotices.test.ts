import { ManualClock, MemoryKeyValueStore } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { KvRunNotices } from './kvRunNotices.js'

describe('KvRunNotices (over core KeyValueStore)', () => {
  it('remembers the review message per run', async () => {
    const notices = new KvRunNotices(new MemoryKeyValueStore())
    expect(await notices.message('run_1')).toBeNull()
    await notices.rememberMessage('run_1', { channelId: '700000000000000001', messageId: '810000000000000001' })
    expect(await notices.message('run_1')).toEqual({ channelId: '700000000000000001', messageId: '810000000000000001' })
  })

  it("remembers a run's copy without buttons apart from its message, and forgets it on request", async () => {
    const notices = new KvRunNotices(new MemoryKeyValueStore())
    expect(await notices.mirror('run_1')).toBeNull()
    await notices.rememberMessage('run_1', { channelId: '700000000000000009', messageId: '810000000000000009' })
    await notices.rememberMirror('run_1', { channelId: '700000000000000001', messageId: '810000000000000001' })
    expect(await notices.mirror('run_1')).toEqual({ channelId: '700000000000000001', messageId: '810000000000000001' })
    expect(await notices.message('run_1')).toEqual({ channelId: '700000000000000009', messageId: '810000000000000009' })
    await notices.rememberMirror('run_1', null)
    expect(await notices.mirror('run_1')).toBeNull()
    expect(await notices.message('run_1')).not.toBeNull()
  })

  it('lets exactly one caller claim the receipts of a run, even concurrently and across instances on one store', async () => {
    const store = new MemoryKeyValueStore()
    const a = new KvRunNotices(store)
    const b = new KvRunNotices(store)
    const claims = await Promise.all([a.claimReceipts('run_1'), b.claimReceipts('run_1'), a.claimReceipts('run_1')])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await b.claimReceipts('run_2')).toBe(true)
  })

  it("remembers a policy preview's two messages and the version they show, in one record, and forgets it on request", async () => {
    const notices = new KvRunNotices(new MemoryKeyValueStore())
    expect(await notices.policyPreview('pol_1')).toBeNull()
    const preview = { version: 1, message: { channelId: '700000000000000009', messageId: '810000000000000009' }, mirror: { channelId: '700000000000000001', messageId: '810000000000000001' } }
    await notices.rememberPolicyPreview('pol_1', preview)
    expect(await notices.policyPreview('pol_1')).toEqual(preview)
    await notices.rememberPolicyPreview('pol_1', null)
    expect(await notices.policyPreview('pol_1')).toBeNull()
  })

  it('keeps its records for 90 days, then lets them go', async () => {
    const clock = new ManualClock()
    const store = new MemoryKeyValueStore(clock)
    const notices = new KvRunNotices(store)
    await notices.rememberMessage('run_1', { channelId: '700000000000000001', messageId: null })
    await notices.claimReceipts('run_1')
    await notices.rememberPolicyPreview('pol_1', { version: 1, message: { channelId: '700000000000000009', messageId: '810000000000000009' }, mirror: null })
    clock.advance(89 * 86_400)
    expect(await notices.message('run_1')).not.toBeNull()
    expect(await notices.claimReceipts('run_1')).toBe(false)
    expect(await notices.policyPreview('pol_1')).not.toBeNull()
    clock.advance(86_400)
    expect(await notices.message('run_1')).toBeNull()
    expect(await notices.policyPreview('pol_1')).toBeNull()
  })
})
