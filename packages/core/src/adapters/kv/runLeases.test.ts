import { describe, expect, it } from 'vitest'
import { MemoryKeyValueStore } from '../memory/keyValue.js'
import { ManualClock } from '../memory/support.js'
import { KvRunLeases } from './runLeases.js'

const RUN = 'run_aaaaaaaaaaaaaaaa'
const TTL = 180

function world() {
  const clock = new ManualClock(new Date('2026-10-07T12:00:00.000Z'))
  const kv = new MemoryKeyValueStore(clock)
  return { clock, kv }
}

describe('KvRunLeases (one worker per pay run, across processes)', () => {
  it('one worker holds a run at a time; another gets it once the first gives it back', async () => {
    const { kv } = world()
    const a = new KvRunLeases(kv, { instance: 'machine-a' })
    const b = new KvRunLeases(kv, { instance: 'machine-b' })
    expect(await a.acquire(RUN, TTL)).toBe(true)
    expect(await b.acquire(RUN, TTL)).toBe(false)
    await a.release(RUN)
    expect(await b.acquire(RUN, TTL)).toBe(true)
  })

  it('a worker in the same process cannot take a run this process already holds', async () => {
    const { kv } = world()
    const a = new KvRunLeases(kv, { instance: 'machine-a' })
    expect(await a.acquire(RUN, TTL)).toBe(true)
    expect(await a.acquire(RUN, TTL)).toBe(false)
  })

  it('a lease left by a process on another machine that died ends by itself after the TTL', async () => {
    const { clock, kv } = world()
    const dead = new KvRunLeases(kv, { instance: 'machine-a' })
    const other = new KvRunLeases(kv, { instance: 'machine-b' })
    expect(await dead.acquire(RUN, TTL)).toBe(true)
    clock.advance(TTL - 1)
    expect(await other.acquire(RUN, TTL)).toBe(false)
    clock.advance(1)
    expect(await other.acquire(RUN, TTL)).toBe(true)
  })

  it('a restarted process takes over at once what an earlier process of the same machine left behind', async () => {
    const { kv } = world()
    const before = new KvRunLeases(kv, { instance: 'machine-a' })
    expect(await before.acquire(RUN, TTL)).toBe(true)
    // The process dies holding it. The next process on the same machine:
    const after = new KvRunLeases(kv, { instance: 'machine-a' })
    expect(await after.acquire(RUN, TTL)).toBe(true)
    // ...and now holds it: the old process's release (if it ever ran) cannot free it.
    await before.release(RUN)
    expect(await new KvRunLeases(kv, { instance: 'machine-b' }).acquire(RUN, TTL)).toBe(false)
  })

  it('releasing a lease that expired and went to someone else leaves theirs alone', async () => {
    const { clock, kv } = world()
    const slow = new KvRunLeases(kv, { instance: 'machine-a' })
    const other = new KvRunLeases(kv, { instance: 'machine-b' })
    expect(await slow.acquire(RUN, TTL)).toBe(true)
    clock.advance(TTL)
    expect(await other.acquire(RUN, TTL)).toBe(true)
    await slow.release(RUN)
    expect(await new KvRunLeases(kv, { instance: 'machine-c' }).acquire(RUN, TTL)).toBe(false)
  })

  it('leases are per run', async () => {
    const { kv } = world()
    const a = new KvRunLeases(kv, { instance: 'machine-a' })
    const b = new KvRunLeases(kv, { instance: 'machine-b' })
    expect(await a.acquire(RUN, TTL)).toBe(true)
    expect(await b.acquire('run_bbbbbbbbbbbbbbbb', TTL)).toBe(true)
  })
})
