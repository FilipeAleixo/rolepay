import type { Generated } from 'kysely'

/**
 * Table shapes. Portable on purpose: TEXT for money (exact decimal micro-units, maps to
 * Postgres NUMERIC), TEXT ISO-8601 for timestamps, TEXT JSON for small nested values.
 * A Postgres dialect can replace SQLite without touching services.
 */
export interface CommunitiesTable {
  id: string
  name: string | null
  network: string
  treasury_address: string
  payout_token: string
  fee_mode: string
  fee_token: string | null
  approver_role_id: string | null
  /** 0 or 1. */
  require_separate_approver: number
  /** 0 or 1. */
  ai_proposals: number
  proposer_role_id: string | null
  /** 0 or 1. */
  preferred_tokens: number
  treasury_channel_id: string | null
  /** 'unset', 'found' or 'chosen'. */
  treasury_channel_source: string
  created_at: string
  updated_at: string
}

export interface BotKeysTable {
  address: string
  community_id: string
  sealed_secret: string
  status: string
  policy: string
  created_at: string
  authorized_at: string | null
  revoked_at: string | null
}

/** A standing policy's own access key (0008): the bot key's shape, bound to one policy. */
export interface PolicyKeysTable {
  address: string
  community_id: string
  policy_id: string
  /** null once the key is revoked or replaced (the secret is destroyed). */
  sealed_secret: string | null
  status: string
  policy: string
  created_at: string
  authorized_at: string | null
  revoked_at: string | null
}

export interface PayeesTable {
  community_id: string
  discord_user_id: string
  address: string
  /** null = the community's payout token. */
  preferred_token: string | null
  /** 0012: 'passkey' or 'external' (default 'passkey' for rows from before). */
  address_kind: string
  registered_at: string
  updated_at: string
}

export interface LinkTokensTable {
  token_hash: string
  community_id: string
  discord_user_id: string
  created_at: string
  expires_at: string
  consumed_at: string | null
  /** 0011: the member's Discord username (it names their passkey), null before. */
  discord_username: string | null
  /** 0012: the live wallet nonce and when it was issued, null when there is none. */
  wallet_nonce: string | null
  wallet_nonce_at: string | null
}

export interface RunsTable {
  id: string
  community_id: string
  token: string
  note: string | null
  status: string
  total: string
  created_by: string
  created_at: string
  updated_at: string
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  attempts: string
  paid_tx_hash: string | null
  paid_block: string | null
  paid_at: string | null
  failure: string | null
  version: number
}

export interface RunLinesTable {
  run_id: string
  line: number
  payee_discord_id: string
  address: string
  amount: string
  memo: string
  /** Both null for a line paid in the run's token; both set for a line delivered by a DEX swap. */
  swap_token: string | null
  swap_max_in: string | null
}

export interface KvTable {
  key: string
  value: string
  expires_at: string | null
}

export interface SetupLinksTable {
  token_hash: string
  community_id: string
  discord_user_id: string
  settings: string
  created_at: string
  expires_at: string
}

export interface PoliciesTable {
  id: string
  community_id: string
  name: string
  instruction: string
  compiled: string
  schedule: string
  caps: string
  channel_id: string | null
  status: string
  version: number
  mode: string
  veto_window_minutes: number
  autopilot: string | null
  created_by: string
  created_at: string
  updated_at: string
  approved_by: string | null
  approved_at: string | null
  active_since: string | null
  rev: number
}

export interface PolicyVersionsTable {
  policy_id: string
  version: number
  community_id: string
  name: string
  instruction: string
  compiled: string
  schedule: string
  caps: string
  authored_by: string
  authored_at: string
  approved_by: string | null
  approved_at: string | null
  discarded_by: string | null
  discarded_at: string | null
}

export interface PolicyRunsTable {
  id: string
  policy_id: string
  policy_version: number
  community_id: string
  period_key: string
  period_start: string
  period_end: string
  mode: string
  status: string
  run_id: string | null
  execute_after: string | null
  lines: string
  unregistered: string
  total: string
  remaining: string | null
  problems: string
  hold: string | null
  vetoed_by: string | null
  vetoed_at: string | null
  released_by: string | null
  released_at: string | null
  lease_until: string | null
  created_at: string
  updated_at: string
  rev: number
}

export interface AuditEventsTable {
  /** Assigned by the database on insert. */
  seq: Generated<number>
  community_id: string
  at: string
  type: string
  actor: string | null
  policy_id: string | null
  policy_version: number | null
  policy_run_id: string | null
  run_id: string | null
  details: string
}

export interface AiUsageTable {
  /** Assigned by the database on insert. */
  seq: Generated<number>
  community_id: string
  purpose: string
  actor: string
  model: string
  input_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  /** US dollars as decimal text ("0.0108"), or null. */
  cost_usd: string | null
  outcome: string
  created_at: string
  proposal_id: string | null
  run_id: string | null
  policy_id: string | null
  policy_version: number | null
}

export interface DepositMastersTable {
  community_id: string
  master_id: string
  master_address: string
  tx_hash: string | null
  /** BIGINT: written as a bigint, read back as a number (block numbers stay far below 2^53). */
  registered_block: bigint | number
  registered_at: string
  scanned_to: bigint | number
}

export interface FundingSourcesTable {
  id: string
  community_id: string
  name: string
  user_tag: string
  deposit_address: string
  created_by: string
  created_at: string
}

export interface DepositsTable {
  tx_hash: string
  log_index: number
  community_id: string
  source_id: string
  token: string
  /** Exact decimal text, e.g. "5" or "0.5". */
  amount: string
  sender: string
  block_number: bigint | number
  block_time: string
}

export interface Database {
  kv: KvTable
  setup_links: SetupLinksTable
  communities: CommunitiesTable
  bot_keys: BotKeysTable
  payees: PayeesTable
  link_tokens: LinkTokensTable
  runs: RunsTable
  run_lines: RunLinesTable
  policies: PoliciesTable
  policy_versions: PolicyVersionsTable
  policy_runs: PolicyRunsTable
  audit_events: AuditEventsTable
  ai_usage: AiUsageTable
  policy_keys: PolicyKeysTable
  deposit_masters: DepositMastersTable
  funding_sources: FundingSourcesTable
  deposits: DepositsTable
}
