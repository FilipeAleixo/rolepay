import { MAX_NOTE_LENGTH } from '@payrun/core'
import { OptionType, Permission } from '../api.js'

/** Guild-installed, usable only inside servers (not in DMs). */
const GUILD_ONLY = { contexts: [0], integration_types: [0] }

const runOption = (description: string) => ({ type: OptionType.String, name: 'run', description, autocomplete: true })

/**
 * The slash commands, as JSON for `PUT /applications/{id}/commands`. /payrun is visible
 * to Manage Server by default (admins can grant it to the Treasurer role in Server
 * Settings > Integrations); the handlers re-check permissions regardless.
 */
export const COMMAND_DEFINITIONS = [
  {
    name: 'payrun',
    description: 'Pay the people who run this server, in one stablecoin transaction',
    type: 1,
    ...GUILD_ONLY,
    default_member_permissions: String(Permission.ManageGuild),
    options: [
      {
        type: OptionType.SubCommand,
        name: 'setup',
        description: 'Register this server, set the approver role, check the bot key',
        options: [
          { type: OptionType.String, name: 'treasury', description: "The community's Tempo account address (needed the first time)" },
          { type: OptionType.Role, name: 'approver_role', description: 'The role allowed to approve pay runs (the Treasurer)' },
          { type: OptionType.String, name: 'token', description: 'Payout token address (default: AlphaUSD on testnet)' },
          { type: OptionType.String, name: 'key_limit', description: 'Bot key spend limit per 30 days, for a new key (default 100)' },
          { type: OptionType.Boolean, name: 'new_key', description: 'Issue a fresh bot key (for example to change its limit)' },
        ],
      },
      {
        type: OptionType.SubCommand,
        name: 'new',
        description: 'Create a pay run for the treasurer to approve',
        options: [
          { type: OptionType.String, name: 'amount', description: 'Amount per person, for example 25 or 12.50', required: true },
          { type: OptionType.Role, name: 'role', description: 'Pay every registered payee who has this role' },
          { type: OptionType.String, name: 'users', description: 'People to pay, for example @alice @bob (or @bob=40 for a different amount)' },
          { type: OptionType.String, name: 'note', description: 'What this run is for (on the receipts and in the CSV)', max_length: MAX_NOTE_LENGTH },
        ],
      },
      {
        type: OptionType.SubCommand,
        name: 'status',
        description: 'Recent pay runs and the bot key, or one run in detail',
        options: [runOption('One run to show (leave empty for the overview)')],
      },
      {
        type: OptionType.SubCommand,
        name: 'export',
        description: 'Download a pay run as CSV for your accounts',
        options: [runOption('The run to export (default: the latest)')],
      },
    ],
  },
  {
    name: 'payee',
    description: 'Get paid by this server',
    type: 1,
    ...GUILD_ONLY,
    options: [{ type: OptionType.SubCommand, name: 'link', description: 'Get your one-time link to register the account you are paid at' }],
  },
]
