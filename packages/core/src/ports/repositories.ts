import type { BotKey, Community, SetupLink } from '../domain/community.js'
import type { LinkToken, Payee } from '../domain/payee.js'
import type { Result } from '../domain/result.js'
import type { Run, RunStatus } from '../domain/run.js'

/** Everything is keyed by Discord guild ID (= community ID). */
export interface CommunityRepository {
  get(id: string): Promise<Community | null>
  insert(community: Community): Promise<Result<void, { code: 'already_exists' }>>
  update(community: Community): Promise<void>
  /** Upsert by key address. */
  saveBotKey(key: BotKey): Promise<void>
  getBotKey(address: string): Promise<BotKey | null>
  /** Newest first. */
  listBotKeys(communityId: string): Promise<BotKey[]>
  /** Setup links exist before the community does (no foreign key). */
  insertSetupLink(link: SetupLink): Promise<void>
  getSetupLink(tokenHash: string): Promise<SetupLink | null>
}

export interface PayeeRepository {
  get(communityId: string, discordUserId: string): Promise<Payee | null>
  /** Upsert by (communityId, discordUserId). */
  upsert(payee: Payee): Promise<void>
  list(communityId: string): Promise<Payee[]>
  insertLinkToken(token: LinkToken): Promise<void>
  getLinkToken(tokenHash: string): Promise<LinkToken | null>
  /** Compare-and-set: true only for the one call that consumed an unconsumed token. */
  consumeLinkToken(tokenHash: string, at: Date): Promise<boolean>
}

export interface RunRepository {
  insert(run: Run): Promise<void>
  get(id: string): Promise<Run | null>
  /** Newest first. */
  listByCommunity(communityId: string, opts?: { limit?: number }): Promise<Run[]>
  listByStatus(status: RunStatus): Promise<Run[]>
  /**
   * Compare-and-set on `version`: stores `next` only if the stored run is at
   * `next.version - 1`. This is what stops two workers from executing one run.
   */
  update(next: Run): Promise<'updated' | 'conflict'>
}
