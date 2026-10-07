import { err, ok } from '../../domain/result.js'
import type { Clock } from '../../ports/clock.js'
import type { IdGenerator } from '../../ports/idGenerator.js'
import type { KeyVault } from '../../ports/keyVault.js'

/** A clock tests move by hand. */
export class ManualClock implements Clock {
  constructor(private current: Date = new Date('2026-10-06T12:00:00.000Z')) {}
  now() {
    return new Date(this.current)
  }
  set(d: Date) {
    this.current = new Date(d)
  }
  advance(seconds: number) {
    this.current = new Date(this.current.getTime() + seconds * 1000)
  }
}

/** Predictable IDs: run_000001, link_000001, ... */
export class SequentialIds implements IdGenerator {
  private n = 0
  runId() {
    return `run_${String(++this.n).padStart(6, '0')}`
  }
  linkToken() {
    return `link_${String(++this.n).padStart(6, '0')}`
  }
  proposalId() {
    return `prop_${String(++this.n).padStart(6, '0')}`
  }
  policyId() {
    return `pol_${String(++this.n).padStart(6, '0')}`
  }
  policyRunId() {
    return `prun_${String(++this.n).padStart(6, '0')}`
  }
}

/** A transparent vault for unit tests: it binds context like the real one, without crypto. */
export class PlainKeyVault implements KeyVault {
  async seal(plaintext: string, context: string) {
    return `plain:${context}:${plaintext}`
  }
  async open(sealed: string, context: string) {
    const prefix = `plain:${context}:`
    return sealed.startsWith(prefix) ? ok(sealed.slice(prefix.length)) : err({ code: 'unseal_failed' as const })
  }
  async fingerprint(value: string) {
    return `fp:${value}`
  }
}
