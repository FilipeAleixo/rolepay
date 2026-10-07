import { ManualClock, MemoryKeyValueStore } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { KvPendingSources } from './kvPendingSources.js'

const message = {
  id: '810000000000000001',
  channelId: '700000000000000001',
  authorId: '300000000000000001',
  authorIsBot: false,
  content: 'Winners: <@200000000000000001>',
  mentionIds: ['200000000000000001'],
  at: new Date('2026-10-06T12:00:00.000Z'),
  replyTo: null,
}
const key = { userId: '300000000000000001', messageId: message.id }

describe('KvPendingSources (the message-command target, kept for its modal)', () => {
  it('round-trips the message once, per person and message', async () => {
    const pending = new KvPendingSources(new MemoryKeyValueStore())
    await pending.put(key, message)
    expect(await pending.take({ ...key, userId: '300000000000000002' })).toBeNull()
    expect(await pending.take(key)).toEqual(message)
    expect(await pending.take(key)).toBeNull()
  })

  it('forgets it after 15 minutes', async () => {
    const clock = new ManualClock()
    const pending = new KvPendingSources(new MemoryKeyValueStore(clock))
    await pending.put(key, message)
    clock.advance(901)
    expect(await pending.take(key)).toBeNull()
  })
})
