import { describe, expect, it } from 'vitest'
import type { AuditEvent } from '../../domain/policy/audit.js'
import { InProcessLiveFeed } from './inProcessLiveFeed.js'

const event = (seq: number, communityId = '1094309218049937418'): AuditEvent => ({
  seq,
  communityId,
  at: new Date('2026-10-06T12:00:00Z'),
  type: 'run.paid',
  actor: null,
  policyId: null,
  policyVersion: null,
  policyRunId: null,
  runId: 'run_000001',
  details: {},
})

describe('InProcessLiveFeed', () => {
  it('hands each published event to every current subscriber, in order, until it unsubscribes', () => {
    const feed = new InProcessLiveFeed()
    const a: number[] = []
    const b: number[] = []
    const stopA = feed.subscribe((e) => a.push(e.seq))
    feed.subscribe((e) => b.push(e.seq))
    feed.publish(event(1))
    feed.publish(event(2))
    stopA()
    stopA() // twice is harmless
    feed.publish(event(3))
    expect(a).toEqual([1, 2])
    expect(b).toEqual([1, 2, 3])
    expect(feed.size).toBe(1)
  })

  it('has no history: a late subscriber sees only what comes after it', () => {
    const feed = new InProcessLiveFeed()
    feed.publish(event(1))
    const seen: number[] = []
    feed.subscribe((e) => seen.push(e.seq))
    feed.publish(event(2))
    expect(seen).toEqual([2])
  })

  it('never lets one subscriber break publishing or the others, and reports the failure', () => {
    const errors: unknown[] = []
    const feed = new InProcessLiveFeed({ onError: (e) => errors.push(e) })
    const seen: number[] = []
    feed.subscribe(() => {
      throw new Error('broken listener')
    })
    feed.subscribe((e) => seen.push(e.seq))
    expect(() => feed.publish(event(1))).not.toThrow()
    expect(seen).toEqual([1])
    expect(errors).toHaveLength(1)
  })

  it('gives each subscriber its own copy, so one cannot change what another sees', () => {
    const feed = new InProcessLiveFeed()
    let second: AuditEvent | null = null
    feed.subscribe((e) => {
      e.details.changed = true
    })
    feed.subscribe((e) => {
      second = e
    })
    feed.publish(event(1))
    expect(second).toMatchObject({ details: {} })
  })

  it('lets a subscriber unsubscribe while an event is being handed out', () => {
    const feed = new InProcessLiveFeed()
    const seen: string[] = []
    const stop = feed.subscribe(() => {
      seen.push('a')
      stop()
    })
    feed.subscribe(() => seen.push('b'))
    feed.publish(event(1))
    feed.publish(event(2))
    expect(seen).toEqual(['a', 'b', 'b'])
  })
})
