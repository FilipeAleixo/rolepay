import type { KeyValueStore } from '@rolepay/core'
import type { RunMessageRef, RunNotices } from '../ports.js'

/** Long enough for any restart or recovery to finish; short enough that the table stays small. */
const TTL_SECONDS = 90 * 86_400
const messageKey = (runId: string) => `discord:run-message:${runId}`
const mirrorKey = (runId: string) => `discord:run-mirror:${runId}`
const receiptsKey = (runId: string) => `discord:receipts:${runId}`

/** RunNotices on core's KeyValueStore (the server's SQLite file, so it survives restarts). */
export class KvRunNotices implements RunNotices {
  constructor(private readonly kv: KeyValueStore) {}

  async rememberMessage(runId: string, ref: RunMessageRef) {
    await this.kv.set(messageKey(runId), ref, { ttl: TTL_SECONDS })
  }

  async message(runId: string) {
    return (await this.kv.get<RunMessageRef>(messageKey(runId))) ?? null
  }

  async rememberMirror(runId: string, ref: RunMessageRef | null) {
    if (ref) await this.kv.set(mirrorKey(runId), ref, { ttl: TTL_SECONDS })
    else await this.kv.delete(mirrorKey(runId))
  }

  async mirror(runId: string) {
    return (await this.kv.get<RunMessageRef>(mirrorKey(runId))) ?? null
  }

  claimReceipts(runId: string) {
    return this.kv.create(receiptsKey(runId), { at: Date.now() }, { ttl: TTL_SECONDS })
  }
}
