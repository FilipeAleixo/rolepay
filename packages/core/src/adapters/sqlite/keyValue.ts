import type { Kysely } from 'kysely'
import type { Clock } from '../../ports/clock.js'
import type { KeyValueStore } from '../../ports/keyValueStore.js'
import type { Database } from './schema.js'

/**
 * KeyValueStore on the `kv` table. Expiry is lazy: expired rows read as absent and are
 * replaced or removed on the next write, or by `sweep`. `create` and `take` are single statements
 * (an upsert guarded by expiry, a DELETE ... RETURNING), so they stay atomic on Postgres too.
 */
export class SqliteKeyValueStore implements KeyValueStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
  ) {}

  private now = () => this.clock.now().toISOString()
  private expiry = (ttl: number | undefined) => (ttl ? new Date(this.clock.now().getTime() + ttl * 1000).toISOString() : null)
  private alive = (expiresAt: string | null) => expiresAt === null || expiresAt > this.now()

  async get<T>(key: string) {
    const row = await this.db.selectFrom('kv').select(['value', 'expires_at']).where('key', '=', key).executeTakeFirst()
    return row && this.alive(row.expires_at) ? (JSON.parse(row.value) as T) : undefined
  }

  async set(key: string, value: unknown, options?: { ttl?: number }) {
    const row = { key, value: JSON.stringify(value), expires_at: this.expiry(options?.ttl) }
    await this.db
      .insertInto('kv')
      .values(row)
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: row.value, expires_at: row.expires_at }))
      .execute()
  }

  async delete(key: string) {
    await this.db.deleteFrom('kv').where('key', '=', key).execute()
  }

  async create(key: string, value: unknown, options?: { ttl?: number }) {
    const row = { key, value: JSON.stringify(value), expires_at: this.expiry(options?.ttl) }
    const result = await this.db
      .insertInto('kv')
      .values(row)
      .onConflict((oc) =>
        oc
          .column('key')
          .doUpdateSet({ value: row.value, expires_at: row.expires_at })
          // Only an expired row may be replaced; a live one makes this a no-op.
          .where((eb) => eb.and([eb('kv.expires_at', 'is not', null), eb('kv.expires_at', '<=', this.now())])),
      )
      .executeTakeFirst()
    return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1
  }

  async sweep() {
    const result = await this.db.deleteFrom('kv').where('expires_at', 'is not', null).where('expires_at', '<=', this.now()).executeTakeFirst()
    return Number(result.numDeletedRows ?? 0n)
  }

  async take<T>(key: string) {
    const row = await this.db.deleteFrom('kv').where('key', '=', key).returning(['value', 'expires_at']).executeTakeFirst()
    return row && this.alive(row.expires_at) ? (JSON.parse(row.value) as T) : undefined
  }
}
