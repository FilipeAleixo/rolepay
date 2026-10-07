import { MAX_NOTE_LENGTH, PROPOSAL_LIMITS } from '@rolepay/core'
import { ChannelType, CommandType, OptionType, Permission } from '../api.js'
import { PROPOSE_MESSAGE_COMMAND } from './proposeFromMessage.js'

/** Guild-installed, usable only inside servers (not in DMs). */
const GUILD_ONLY = { contexts: [0], integration_types: [0] }

const runOption = (description: string) => ({ type: OptionType.String, name: 'run', description, autocomplete: true })

/** Testnet only (Moderato with PAYRUN_DEV_SHORTCUTS=true); never registered anywhere else. */
const DEV_SETUP_OPTIONS = [
  { type: OptionType.String, name: 'treasury', description: 'Dev shortcut: an existing treasury address instead of the passkey page' },
  { type: OptionType.String, name: 'key_limit', description: 'Dev shortcut: spend limit for a new key issued here (default 100)' },
  { type: OptionType.Boolean, name: 'new_key', description: 'Dev shortcut: issue a fresh key here, for pnpm dev:authorize-key' },
]

/**
 * The slash commands, as JSON for `PUT /applications/{id}/commands`. /payrun is visible
 * to Manage Server by default (admins can grant it to the Treasurer role in Server
 * Settings > Integrations); the handlers re-check permissions regardless. The dev shortcut
 * options exist only when `devShortcuts` is on (the handler refuses them otherwise anyway).
 */
export const commandDefinitions = (opts: { devShortcuts: boolean }) => [
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
          { type: OptionType.Role, name: 'approver_role', description: 'The role allowed to approve pay runs (the Treasurer); needed the first time' },
          {
            type: OptionType.String,
            name: 'fees',
            description: 'Who pays the network fee of each run',
            choices: [
              { name: 'Sponsored (default)', value: 'sponsor' },
              { name: 'From a fee budget the bot key carries', value: 'fee_budget' },
            ],
          },
          { type: OptionType.String, name: 'fee_token', description: 'Fee budget token address (default: pathUSD on testnet)' },
          { type: OptionType.String, name: 'token', description: 'Payout token address, the first time (default: AlphaUSD on testnet)' },
          { type: OptionType.Boolean, name: 'separate_approver', description: 'Require someone other than the creator of a run to approve it (off by default)' },
          { type: OptionType.Boolean, name: 'ai_proposals', description: "AI-proposed pay runs on or off (off by default; messages go to Anthropic's API)" },
          { type: OptionType.Role, name: 'proposer_role', description: 'A role that may propose runs with AI besides the approver role' },
          ...(opts.devShortcuts ? DEV_SETUP_OPTIONS : []),
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
        name: 'propose',
        description: 'Ask the AI for a pay run proposal (you review it; a treasurer approves the run)',
        options: [
          {
            type: OptionType.String,
            name: 'instruction',
            description: 'For example: pay 20 to every Mod with 10 replies in #help this month',
            required: true,
            max_length: PROPOSAL_LIMITS.maxInstructionLength,
          },
          {
            type: OptionType.Channel,
            name: 'source',
            description: 'Read this channel or thread and propose from its messages (else: a filter)',
            channel_types: [ChannelType.Text, ChannelType.Announcement, ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread],
          },
          { type: OptionType.String, name: 'since', description: `How far back to read the source, like 24h or 7d (default 7d, at most ${PROPOSAL_LIMITS.maxLookbackDays}d)` },
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
    // Right-click a message > Apps > Propose pay run. Message commands have a name and no description.
    name: PROPOSE_MESSAGE_COMMAND,
    type: CommandType.Message,
    ...GUILD_ONLY,
    default_member_permissions: String(Permission.ManageGuild),
  },
  {
    name: 'payee',
    description: 'Get paid by this server',
    type: 1,
    ...GUILD_ONLY,
    options: [{ type: OptionType.SubCommand, name: 'link', description: 'Get your one-time link to register the account you are paid at' }],
  },
]

/** The production commands: no dev shortcuts. */
export const COMMAND_DEFINITIONS = commandDefinitions({ devShortcuts: false })
