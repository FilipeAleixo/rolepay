import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { Clock } from '../../ports/clock.js'
import { SystemClock } from '../crypto/index.js'
import { KvProposalRepository } from '../kv/proposals.js'
import { SqliteKeyValueStore } from './keyValue.js'
import { migrateToLatest } from './migrations.js'
import { SqliteAuditLog, SqlitePolicyRepository, SqlitePolicyRunRepository } from './policyRepositories.js'
import { SqliteCommunityRepository, SqlitePayeeRepository, SqliteRunRepository } from './repositories.js'
import type { Database } from './schema.js'

/** Opens (and migrates) the SQLite database at `path`. One process owns the file. */
export async function openSqliteDatabase(path: string, options: { clock?: Clock } = {}) {
  const sqlite = new BetterSqlite3(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  await migrateToLatest(db as unknown as Kysely<unknown>)
  const clock = options.clock ?? new SystemClock()
  const kv = new SqliteKeyValueStore(db, clock)
  return {
    repositories: {
      communities: new SqliteCommunityRepository(db),
      payees: new SqlitePayeeRepository(db),
      runs: new SqliteRunRepository(db),
      // Drafts that expire within a day: kept in the key-value table, no migration needed.
      proposals: new KvProposalRepository(kv, clock),
      policies: new SqlitePolicyRepository(db),
      policyRuns: new SqlitePolicyRunRepository(db),
      audit: new SqliteAuditLog(db),
    },
    kv,
    close: () => db.destroy(),
  }
}

export type { Database } from './schema.js'
