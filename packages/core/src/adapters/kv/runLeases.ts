import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { KeyValueStore } from '../../ports/keyValueStore.js'
import type { RunLeases } from '../../ports/runLeases.js'

type Lease = { instance: string; process: string }
const leaseKey = (runId: string) => `run-lease:${runId}`

/**
 * RunLeases on core's KeyValueStore (the server's SQLite file), with the store's atomic
 * create-if-absent. A lease names the instance (the machine: its hostname, which on Fly is the
 * machine ID) and the process. One process runs per instance, so a lease left by an EARLIER process
 * of the same instance (it crashed, or was cut off at shutdown, holding it) is taken over at once:
 * a restart recovers its runs straight away instead of waiting out the TTL. A lease held by another
 * instance is respected until it is released or expires.
 */
export class KvRunLeases implements RunLeases {
  private readonly me: Lease
  /** Runs this process holds: a second worker in the same process never gets one. */
  private readonly held = new Set<string>()

  constructor(
    private readonly kv: KeyValueStore,
    opts: { instance?: string } = {},
  ) {
    this.me = { instance: opts.instance ?? hostname(), process: randomUUID() }
  }

  async acquire(runId: string, ttlSeconds: number): Promise<boolean> {
    if (this.held.has(runId)) return false
    if (await this.kv.create(leaseKey(runId), this.me, { ttl: ttlSeconds })) return this.took(runId)
    const current = await this.kv.get<Lease>(leaseKey(runId))
    if (current === undefined) {
      // It expired between the two calls: one more try, still atomic.
      return (await this.kv.create(leaseKey(runId), this.me, { ttl: ttlSeconds })) ? this.took(runId) : false
    }
    if (current.instance === this.me.instance && current.process !== this.me.process) {
      // An earlier process of this instance died holding it: nobody is working on the run.
      await this.kv.set(leaseKey(runId), this.me, { ttl: ttlSeconds })
      return this.took(runId)
    }
    return false
  }

  async release(runId: string): Promise<void> {
    if (!this.held.delete(runId)) return
    const current = await this.kv.get<Lease>(leaseKey(runId))
    if (current?.process === this.me.process) await this.kv.delete(leaseKey(runId))
  }

  private took(runId: string): true {
    this.held.add(runId)
    return true
  }
}
