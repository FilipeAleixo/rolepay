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

export interface PayeesTable {
  community_id: string
  discord_user_id: string
  address: string
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
}

export interface Database {
  communities: CommunitiesTable
  bot_keys: BotKeysTable
  payees: PayeesTable
  link_tokens: LinkTokensTable
  runs: RunsTable
  run_lines: RunLinesTable
}
