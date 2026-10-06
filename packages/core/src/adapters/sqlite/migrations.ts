import type { Kysely } from 'kysely'
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration'

/**
 * Append-only. Never edit a migration that has shipped; add the next one.
 * Uses only the portable subset of the schema builder (text/integer, FKs, indexes).
 */
const migrations: Record<string, Migration> = {
  '0001_initial': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('communities')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text')
        .addColumn('network', 'text', (c) => c.notNull())
        .addColumn('treasury_address', 'text', (c) => c.notNull())
        .addColumn('payout_token', 'text', (c) => c.notNull())
        .addColumn('fee_mode', 'text', (c) => c.notNull())
        .addColumn('fee_token', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute()

      await db.schema
        .createTable('bot_keys')
        .addColumn('address', 'text', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('sealed_secret', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('policy', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('authorized_at', 'text')
        .addColumn('revoked_at', 'text')
        .execute()
      await db.schema.createIndex('bot_keys_community').on('bot_keys').columns(['community_id', 'created_at']).execute()

      await db.schema
        .createTable('payees')
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('discord_user_id', 'text', (c) => c.notNull())
        .addColumn('address', 'text', (c) => c.notNull())
        .addColumn('registered_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('payees_pk', ['community_id', 'discord_user_id'])
        .execute()

      await db.schema
        .createTable('link_tokens')
        .addColumn('token_hash', 'text', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('discord_user_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('consumed_at', 'text')
        .execute()

      await db.schema
        .createTable('runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('total', 'text', (c) => c.notNull())
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('submitted_at', 'text')
        .addColumn('approved_by', 'text')
        .addColumn('approved_at', 'text')
        .addColumn('cancelled_by', 'text')
        .addColumn('cancelled_at', 'text')
        .addColumn('attempts', 'text', (c) => c.notNull())
        .addColumn('paid_tx_hash', 'text')
        .addColumn('paid_block', 'text')
        .addColumn('paid_at', 'text')
        .addColumn('failure', 'text')
        .addColumn('version', 'integer', (c) => c.notNull())
        .execute()
      await db.schema.createIndex('runs_community').on('runs').columns(['community_id', 'created_at']).execute()
      await db.schema.createIndex('runs_status').on('runs').column('status').execute()

      await db.schema
        .createTable('run_lines')
        .addColumn('run_id', 'text', (c) => c.notNull().references('runs.id').onDelete('cascade'))
        .addColumn('line', 'integer', (c) => c.notNull())
        .addColumn('payee_discord_id', 'text', (c) => c.notNull())
        .addColumn('address', 'text', (c) => c.notNull())
        .addColumn('amount', 'text', (c) => c.notNull())
        .addColumn('memo', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('run_lines_pk', ['run_id', 'line'])
        .execute()
    },
  },
}

class InlineMigrations implements MigrationProvider {
  async getMigrations() {
    return migrations
  }
}

export async function migrateToLatest(db: Kysely<unknown>) {
  const { error, results } = await new Migrator({ db, provider: new InlineMigrations() }).migrateToLatest()
  const failed = results?.find((r) => r.status === 'Error')
  if (error || failed) throw new Error(`migration failed: ${failed?.migrationName ?? ''} ${String(error ?? '')}`)
}
