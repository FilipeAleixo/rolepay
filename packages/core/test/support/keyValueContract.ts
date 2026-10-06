// Behavioural contract for KeyValueStore. Runs against the in-memory store and SQLite, so
// the web layer (passkey credentials and sessions) and the Discord layer (delivery markers)
// can trust either.
import { beforeEach, describe, expect, it } from 'vitest'
import { ManualClock } from '../../src/adapters/memory/support.js'
import type { KeyValueStore } from '../../src/ports/keyValueStore.js'

export type KvFactory = (clock: ManualClock) => Promise<KeyValueStore>

export function keyValueContract(name: string, make: KvFactory) {
  describe(`${name}: KeyValueStore`, () => {
    let clock: ManualClock
    let kv: KeyValueStore
    beforeEach(async () => {
      clock = new ManualClock()
      kv = await make(clock)
    })

    it('returns undefined for a missing key', async () => {
      expect(await kv.get('nope')).toBeUndefined()
    })

    it('round-trips JSON values and overwrites on set', async () => {
      await kv.set('a', { publicKey: '0xabc', n: 1, list: [1, 'two'], nested: { ok: true } })
      expect(await kv.get('a')).toEqual({ publicKey: '0xabc', n: 1, list: [1, 'two'], nested: { ok: true } })
      await kv.set('a', 42)
      expect(await kv.get('a')).toBe(42)
      await kv.set('s', 'text')
      expect(await kv.get('s')).toBe('text')
    })

    it('deletes', async () => {
      await kv.set('a', 1)
      await kv.delete('a')
      expect(await kv.get('a')).toBeUndefined()
      await kv.delete('never-there')
    })

    it('expires a value after its ttl (seconds), and keeps one without a ttl', async () => {
      await kv.set('short', 'x', { ttl: 60 })
      await kv.set('forever', 'y')
      clock.advance(59)
      expect(await kv.get('short')).toBe('x')
      clock.advance(1)
      expect(await kv.get('short')).toBeUndefined()
      expect(await kv.get('forever')).toBe('y')
    })

    it('create writes only when absent, and true only for the one call that wrote', async () => {
      expect(await kv.create('c', 'first')).toBe(true)
      expect(await kv.create('c', 'second')).toBe(false)
      expect(await kv.get('c')).toBe('first')
    })

    it('create is atomic under concurrency', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => kv.create('race', i)))
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('create replaces an expired value', async () => {
      await kv.set('c', 'old', { ttl: 10 })
      clock.advance(10)
      expect(await kv.create('c', 'new', { ttl: 10 })).toBe(true)
      expect(await kv.get('c')).toBe('new')
    })

    it('take returns the value once and removes it', async () => {
      await kv.set('t', { v: 1 })
      expect(await kv.take('t')).toEqual({ v: 1 })
      expect(await kv.take('t')).toBeUndefined()
      expect(await kv.get('t')).toBeUndefined()
    })

    it('take is atomic under concurrency', async () => {
      await kv.set('t', 'once')
      const results = await Promise.all(Array.from({ length: 8 }, () => kv.take('t')))
      expect(results.filter((r) => r !== undefined)).toEqual(['once'])
    })

    it('take does not return an expired value', async () => {
      await kv.set('t', 'x', { ttl: 5 })
      clock.advance(5)
      expect(await kv.take('t')).toBeUndefined()
    })

    it('hands out copies', async () => {
      await kv.set('o', { list: [1] })
      const got = await kv.get<{ list: number[] }>('o')
      got?.list.push(2)
      expect(await kv.get('o')).toEqual({ list: [1] })
    })
  })
}
