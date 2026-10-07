import type { Kysely, Selectable } from 'kysely'
import { type PolicyKey, PolicyKeySchema } from '../../domain/policy/policyKey.js'
import type { PolicyKeyRepository } from '../../ports/repositories.js'
import type { Database, PolicyKeysTable } from './schema.js'

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const dateOrNull = (s: string | null) => (s ? new Date(s) : null)

function toPolicyKey(r: Selectable<PolicyKeysTable>): PolicyKey {
  const p = JSON.parse(r.policy)
  return PolicyKeySchema.parse({
    address: r.address,
    communityId: r.community_id,
    policyId: r.policy_id,
    sealedSecret: r.sealed_secret,
    status: r.status,
    policy: { ...p, limit: BigInt(p.limit), feeBudget: p.feeBudget === null ? null : BigInt(p.feeBudget) },
    createdAt: new Date(r.created_at),
    authorizedAt: dateOrNull(r.authorized_at),
    revokedAt: dateOrNull(r.revoked_at),
  })
}

/** Policies' own access keys, in their own table; every read is re-validated by the domain schema. */
export class SqlitePolicyKeyRepository implements PolicyKeyRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async save(k: PolicyKey) {
    const row = {
      address: k.address,
      community_id: k.communityId,
      policy_id: k.policyId,
      sealed_secret: k.sealedSecret,
      status: k.status,
      policy: json(k.policy),
      created_at: k.createdAt.toISOString(),
      authorized_at: k.authorizedAt ? k.authorizedAt.toISOString() : null,
      revoked_at: k.revokedAt ? k.revokedAt.toISOString() : null,
    }
    const { address: _a, ...update } = row
    await this.db.insertInto('policy_keys').values(row).onConflict((oc) => oc.column('address').doUpdateSet(update)).execute()
  }

  async get(address: string) {
    const row = await this.db.selectFrom('policy_keys').selectAll().where('address', '=', address).executeTakeFirst()
    return row ? toPolicyKey(row) : null
  }

  async listByPolicy(policyId: string) {
    const rows = await this.db.selectFrom('policy_keys').selectAll().where('policy_id', '=', policyId).orderBy('created_at', 'desc').orderBy('address', 'desc').execute()
    return rows.map(toPolicyKey)
  }

  async listByCommunity(communityId: string) {
    const rows = await this.db.selectFrom('policy_keys').selectAll().where('community_id', '=', communityId).orderBy('created_at', 'desc').orderBy('address', 'desc').execute()
    return rows.map(toPolicyKey)
  }
}
