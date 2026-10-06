import type { KeyValueStore } from '@payrun/core'
import type { InteractionLog } from '../ports.js'

/** Longer than Discord's 5-minute signature window, after which a replay fails verification anyway. */
const TTL_SECONDS = 600

/** InteractionLog on core's KeyValueStore: one atomic create-if-absent per interaction ID. */
export class KvInteractionLog implements InteractionLog {
  constructor(private readonly kv: KeyValueStore) {}

  firstSeen(interactionId: string) {
    return this.kv.create(`discord:interaction:${interactionId}`, true, { ttl: TTL_SECONDS })
  }
}
