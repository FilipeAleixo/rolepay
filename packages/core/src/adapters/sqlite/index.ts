import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { migrateToLatest } from './migrations.js'
import { SqliteCommunityRepository, SqlitePayeeRepository, SqliteRunRepository } from './repositories.js'
import type { Database } from './schema.js'

/** Opens (and migrates) the SQLite database at `path`. One process owns the file. */
export async function openSqliteDatabase(path: string) {
  const sqlite = new BetterSqlite3(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  await migrateToLatest(db as unknown as Kysely<unknown>)
  return {
    repositories: {
      communities: new SqliteCommunityRepository(db),
      payees: new SqlitePayeeRepository(db),
      runs: new SqliteRunRepository(db),
    },
    close: () => db.destroy(),
  }
}

export type { Database } from './schema.js'
