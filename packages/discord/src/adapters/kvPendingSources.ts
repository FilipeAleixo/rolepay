import { type KeyValueStore, SourceMessageSchema, type SourceMessage } from '@payrun/core'
import type { PendingSources } from '../ports.js'

/** A modal answered after 15 minutes finds nothing (Discord's own interaction tokens last that long). */
const TTL_SECONDS = 900

/** PendingSources on core's KeyValueStore: one record per (person, message), taken once. */
export class KvPendingSources implements PendingSources {
  constructor(private readonly kv: KeyValueStore) {}

  async put(key: { userId: string; messageId: string }, message: SourceMessage) {
    await this.kv.set(this.key(key), { ...message, at: message.at.toISOString() }, { ttl: TTL_SECONDS })
  }

  async take(key: { userId: string; messageId: string }) {
    const stored = await this.kv.take<Record<string, unknown>>(this.key(key))
    if (!stored) return null
    const parsed = SourceMessageSchema.safeParse({ ...stored, at: new Date(String(stored.at)) })
    return parsed.success ? parsed.data : null
  }

  private key(k: { userId: string; messageId: string }) {
    return `discord:pending-source:${k.userId}:${k.messageId}`
  }
}
