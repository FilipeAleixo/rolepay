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
        .addColumn('approver_role_id', 'text')
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
  '0002_key_value': {
    async up(db: Kysely<unknown>) {
      // Small JSON records with an optional expiry (KeyValueStore). expires_at is ISO text or null.
      await db.schema
        .createTable('kv')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text')
        .execute()
    },
  },
  '0003_setup_links': {
    async up(db: Kysely<unknown>) {
      // No foreign key: a first setup link exists before its community is registered.
      await db.schema
        .createTable('setup_links')
        .addColumn('token_hash', 'text', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull())
        .addColumn('discord_user_id', 'text', (c) => c.notNull())
        .addColumn('settings', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .execute()
    },
  },
  '0004_require_separate_approver': {
    async up(db: Kysely<unknown>) {
      // Four eyes per community (0/1, portable to Postgres as integer). Existing rows: off.
      await db.schema
        .alterTable('communities')
        .addColumn('require_separate_approver', 'integer', (c) => c.notNull().defaultTo(0))
        .execute()
    },
  },
  '0005_ai_proposals': {
    async up(db: Kysely<unknown>) {
      // AI proposals per community (0/1, off for existing rows) and the optional proposer role.
      await db.schema.alterTable('communities').addColumn('ai_proposals', 'integer', (c) => c.notNull().defaultTo(0)).execute()
      await db.schema.alterTable('communities').addColumn('proposer_role_id', 'text').execute()
    },
  },
  '0006_policies': {
    async up(db: Kysely<unknown>) {
      // Standing policies. Small nested values (the compiled rule, schedule, caps, autopilot) as JSON text.
      await db.schema
        .createTable('policies')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('instruction', 'text', (c) => c.notNull())
        .addColumn('compiled', 'text', (c) => c.notNull())
        .addColumn('schedule', 'text', (c) => c.notNull())
        .addColumn('caps', 'text', (c) => c.notNull())
        .addColumn('channel_id', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('mode', 'text', (c) => c.notNull())
        .addColumn('veto_window_minutes', 'integer', (c) => c.notNull())
        .addColumn('autopilot', 'text')
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('approved_by', 'text')
        .addColumn('approved_at', 'text')
        .addColumn('active_since', 'text')
        .addColumn('rev', 'integer', (c) => c.notNull())
        .execute()
      await db.schema.createIndex('policies_community').on('policies').columns(['community_id', 'created_at']).execute()
      await db.schema.createIndex('policies_status').on('policies').column('status').execute()

      await db.schema
        .createTable('policy_versions')
        .addColumn('policy_id', 'text', (c) => c.notNull().references('policies.id').onDelete('cascade'))
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('community_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('instruction', 'text', (c) => c.notNull())
        .addColumn('compiled', 'text', (c) => c.notNull())
        .addColumn('schedule', 'text', (c) => c.notNull())
        .addColumn('caps', 'text', (c) => c.notNull())
        .addColumn('authored_by', 'text', (c) => c.notNull())
        .addColumn('authored_at', 'text', (c) => c.notNull())
        .addColumn('approved_by', 'text')
        .addColumn('approved_at', 'text')
        .addColumn('discarded_by', 'text')
        .addColumn('discarded_at', 'text')
        .addPrimaryKeyConstraint('policy_versions_pk', ['policy_id', 'version'])
        .execute()

      // One run per policy per period: the unique key is what makes a double tick or a second instance harmless.
      await db.schema
        .createTable('policy_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('policy_id', 'text', (c) => c.notNull().references('policies.id').onDelete('cascade'))
        .addColumn('policy_version', 'integer', (c) => c.notNull())
        .addColumn('community_id', 'text', (c) => c.notNull())
        .addColumn('period_key', 'text', (c) => c.notNull())
        .addColumn('period_start', 'text', (c) => c.notNull())
        .addColumn('period_end', 'text', (c) => c.notNull())
        .addColumn('mode', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text')
        .addColumn('execute_after', 'text')
        .addColumn('lines', 'text', (c) => c.notNull())
        .addColumn('unregistered', 'text', (c) => c.notNull())
        .addColumn('total', 'text', (c) => c.notNull())
        .addColumn('remaining', 'text')
        .addColumn('problems', 'text', (c) => c.notNull())
        .addColumn('hold', 'text')
        .addColumn('vetoed_by', 'text')
        .addColumn('vetoed_at', 'text')
        .addColumn('released_by', 'text')
        .addColumn('released_at', 'text')
        .addColumn('lease_until', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('rev', 'integer', (c) => c.notNull())
        .addUniqueConstraint('policy_runs_period', ['policy_id', 'period_key'])
        .execute()
      await db.schema.createIndex('policy_runs_community').on('policy_runs').columns(['community_id', 'period_end']).execute()
      await db.schema.createIndex('policy_runs_status').on('policy_runs').column('status').execute()
      await db.schema.createIndex('policy_runs_run').on('policy_runs').column('run_id').execute()

      // The audit stream, append-only. `seq` is the row ID (an identity column on Postgres).
      await db.schema
        .createTable('audit_events')
        .addColumn('seq', 'integer', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull())
        .addColumn('at', 'text', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('actor', 'text')
        .addColumn('policy_id', 'text')
        .addColumn('policy_version', 'integer')
        .addColumn('policy_run_id', 'text')
        .addColumn('run_id', 'text')
        .addColumn('details', 'text', (c) => c.notNull())
        .execute()
      await db.schema.createIndex('audit_events_community').on('audit_events').columns(['community_id', 'seq']).execute()
      await db.schema.createIndex('audit_events_policy').on('audit_events').column('policy_id').execute()
      await db.schema.createIndex('audit_events_run').on('audit_events').column('run_id').execute()
    },
  },
  '0007_ai_usage': {
    async up(db: Kysely<unknown>) {
      // One row per model call: counts, codes, IDs and the estimated cost (decimal USD text, NUMERIC
      // on Postgres), never any text. `seq` is the row ID (an identity column on Postgres). A new
      // table only, so it applies to a database with data as to an empty one.
      await db.schema
        .createTable('ai_usage')
        .addColumn('seq', 'integer', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull())
        .addColumn('purpose', 'text', (c) => c.notNull())
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('model', 'text', (c) => c.notNull())
        .addColumn('input_tokens', 'integer')
        .addColumn('cache_creation_input_tokens', 'integer')
        .addColumn('cache_read_input_tokens', 'integer')
        .addColumn('output_tokens', 'integer')
        .addColumn('latency_ms', 'integer')
        .addColumn('cost_usd', 'text')
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('proposal_id', 'text')
        .addColumn('run_id', 'text')
        .addColumn('policy_id', 'text')
        .addColumn('policy_version', 'integer')
        .execute()
      await db.schema.createIndex('ai_usage_community').on('ai_usage').columns(['community_id', 'created_at']).execute()
      await db.schema.createIndex('ai_usage_proposal').on('ai_usage').column('proposal_id').execute()
      await db.schema.createIndex('ai_usage_policy').on('ai_usage').column('policy_id').execute()
    },
  },
  '0010_funding': {
    async up(db: Kysely<unknown>) {
      // Funding with attribution (virtual addresses). New tables only, so it applies to a database
      // with data as to an empty one. Block numbers are BIGINT (the watcher's cursor only moves
      // forward, compared in SQL); amounts are exact decimal text (NUMERIC on Postgres).
      await db.schema
        .createTable('deposit_masters')
        .addColumn('community_id', 'text', (c) => c.primaryKey().references('communities.id').onDelete('cascade'))
        .addColumn('master_id', 'text', (c) => c.notNull())
        .addColumn('master_address', 'text', (c) => c.notNull())
        .addColumn('tx_hash', 'text')
        .addColumn('registered_block', 'bigint', (c) => c.notNull())
        .addColumn('registered_at', 'text', (c) => c.notNull())
        .addColumn('scanned_to', 'bigint', (c) => c.notNull())
        .execute()
      await db.schema
        .createTable('funding_sources')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('user_tag', 'text', (c) => c.notNull())
        .addColumn('deposit_address', 'text', (c) => c.notNull())
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        // One source per user tag: two creates racing for the same tag, one wins.
        .addUniqueConstraint('funding_sources_tag', ['community_id', 'user_tag'])
        .execute()
      await db.schema
        .createTable('deposits')
        .addColumn('tx_hash', 'text', (c) => c.notNull())
        .addColumn('log_index', 'integer', (c) => c.notNull())
        .addColumn('community_id', 'text', (c) => c.notNull().references('communities.id').onDelete('cascade'))
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('amount', 'text', (c) => c.notNull())
        .addColumn('sender', 'text', (c) => c.notNull())
        .addColumn('block_number', 'bigint', (c) => c.notNull())
        .addColumn('block_time', 'text', (c) => c.notNull())
        // The watcher's idempotency: each deposit (its first Transfer event) is stored once, by any instance.
        .addPrimaryKeyConstraint('deposits_pk', ['tx_hash', 'log_index'])
        .execute()
      await db.schema.createIndex('deposits_community').on('deposits').columns(['community_id', 'block_number']).execute()
      await db.schema.createIndex('deposits_source').on('deposits').column('source_id').execute()
    },
  },
}

/** Every migration's name, in the order they run (tests build a database as an earlier release left it). */
export const MIGRATION_NAMES: readonly string[] = Object.keys(migrations).sort()

class InlineMigrations implements MigrationProvider {
  async getMigrations() {
    return migrations
  }
}

export async function migrateToLatest(db: Kysely<unknown>) {
  check(await new Migrator({ db, provider: new InlineMigrations() }).migrateToLatest())
}

/** Up to and including `name` only: tests build a database as an earlier release left it. */
export async function migrateTo(db: Kysely<unknown>, name: string) {
  check(await new Migrator({ db, provider: new InlineMigrations() }).migrateTo(name))
}

function check({ error, results }: Awaited<ReturnType<Migrator['migrateToLatest']>>) {
  const failed = results?.find((r) => r.status === 'Error')
  if (error || failed) throw new Error(`migration failed: ${failed?.migrationName ?? ''} ${String(error ?? '')}`)
}
