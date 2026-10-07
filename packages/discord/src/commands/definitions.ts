import { MAX_NOTE_LENGTH, type NetworkName, POLICY_LIMITS, PREFERRED_TOKENS, PROPOSAL_LIMITS, TOKEN_SYMBOLS, WEEKDAYS } from '@rolepay/core'
import { ChannelType, CommandType, OptionType, Permission } from '../api.js'
import { PROPOSE_MESSAGE_COMMAND } from './proposeFromMessage.js'

/** Guild-installed, usable only inside servers (not in DMs). */
const GUILD_ONLY = { contexts: [0], integration_types: [0] }

const runOption = (description: string) => ({ type: OptionType.String, name: 'run', description, autocomplete: true })

/** Testnet only (Moderato with ROLEPAY_DEV_SHORTCUTS=true); never registered anywhere else. */
const DEV_SETUP_OPTIONS = [
  { type: OptionType.String, name: 'treasury', description: 'Dev shortcut: an existing treasury address instead of the passkey page' },
  { type: OptionType.String, name: 'key_limit', description: 'Dev shortcut: spend limit for a new key issued here (default 100)' },
  { type: OptionType.Boolean, name: 'new_key', description: 'Dev shortcut: issue a fresh key here, for pnpm dev:authorize-key' },
]

const policyOption = (description: string) => ({ type: OptionType.String, name: 'policy', description, required: true, autocomplete: true })
const capitalised = (w: string) => `${w[0]?.toUpperCase()}${w.slice(1)}`

/**
 * /rolepay policy: standing policies. The AI compiles the instruction once; the approver role
 * approves, pauses, resumes and switches modes; code runs it on its schedule. `run_now`,
 * `veto_minutes` and the daily schedule are demo controls (ROLEPAY_DEMO_CONTROLS on Moderato: a
 * demo can skip to Monday, use a short veto window, and pay judges every day), separate from the
 * dev shortcuts.
 */
const policyGroup = (opts: { demoControls: boolean }) => ({
  type: OptionType.SubCommandGroup,
  name: 'policy',
  description: 'Standing policies: a rule the AI writes once, a treasurer approves, and code runs on a schedule',
  options: [
    {
      type: OptionType.SubCommand,
      name: 'new',
      description: 'Write a standing policy; you see who it applies to before a treasurer approves it',
      options: [
        {
          type: OptionType.String,
          name: 'instruction',
          description: 'For example: 1 per answered question in #help, max 50 a week each, for Mods',
          required: true,
          max_length: PROPOSAL_LIMITS.maxInstructionLength,
        },
        {
          type: OptionType.String,
          name: 'schedule',
          description: 'How often it runs',
          required: true,
          choices: [
            // Daily is a demo control: a judge gets paid by the next daily run with nobody online.
            ...(opts.demoControls ? [{ name: 'Daily (demo control)', value: 'daily' }] : []),
            { name: 'Weekly', value: 'weekly' },
            { name: 'Monthly', value: 'monthly' },
          ],
        },
        { type: OptionType.Integer, name: 'hour', description: 'The hour it runs, 0 to 23, in the timezone (default UTC)', required: true, min_value: 0, max_value: 23 },
        { type: OptionType.String, name: 'weekday', description: 'Weekly: the day it runs', choices: WEEKDAYS.map((d) => ({ name: capitalised(d), value: d })) },
        { type: OptionType.Integer, name: 'day', description: 'Monthly: the day of the month, 1 to 31 (the last day in shorter months)', min_value: 1, max_value: 31 },
        { type: OptionType.String, name: 'timezone', description: 'An IANA timezone such as Europe/Lisbon (default UTC)', max_length: 64 },
        { type: OptionType.String, name: 'name', description: 'A short name for the policy', max_length: POLICY_LIMITS.maxNameLength },
        { type: OptionType.String, name: 'max_per_run', description: 'Hold any run above this total (for example 500)' },
        { type: OptionType.String, name: 'max_per_person', description: 'Never pay one person more than this per run' },
      ],
    },
    { type: OptionType.SubCommand, name: 'list', description: 'The policies of this server, their schedules and next runs' },
    { type: OptionType.SubCommand, name: 'show', description: 'One policy: the rule, who it applies to right now, the next run', options: [policyOption('The policy')] },
    { type: OptionType.SubCommand, name: 'pause', description: 'Stop a policy from running (the approver role)', options: [policyOption('The policy to pause')] },
    { type: OptionType.SubCommand, name: 'resume', description: 'Let a paused policy run again (the approver role)', options: [policyOption('The policy to resume')] },
    {
      type: OptionType.SubCommand,
      name: 'mode',
      description: 'Propose (each run waits for approval) or autopilot (pays after a veto window)',
      options: [
        policyOption('The policy'),
        {
          type: OptionType.String,
          name: 'mode',
          description: 'How its runs are approved',
          required: true,
          choices: [
            { name: 'Propose: each run waits for the one-tap approval', value: 'propose' },
            { name: 'Autopilot: pays after the veto window unless vetoed', value: 'autopilot' },
          ],
        },
        { type: OptionType.Integer, name: 'veto_hours', description: 'Autopilot: hours to veto a run before it pays (default 24, at least 1)', min_value: 1, max_value: POLICY_LIMITS.maxVetoMinutes / 60 },
        ...(opts.demoControls ? [{ type: OptionType.Integer, name: 'veto_minutes', description: 'Demo control: a veto window in minutes', min_value: 1, max_value: POLICY_LIMITS.maxVetoMinutes }] : []),
      ],
    },
    ...(opts.demoControls
      ? [{ type: OptionType.SubCommand, name: 'run_now', description: "Demo control: make the policy's next run now", options: [policyOption('The policy')] }]
      : []),
  ],
})

/**
 * /payee prefer: the USD stablecoin a payee wants to be paid in, from the network's fixed list
 * (`PREFERRED_TOKENS`), or the server's payout token. The value is the token's address; core checks
 * it again against what the community can deliver.
 */
const payeePrefer = (network: NetworkName) => ({
  type: OptionType.SubCommand,
  name: 'prefer',
  description: 'Choose the USD stablecoin you are paid in (swapped for you on Tempo, when the server allows it)',
  options: [
    {
      type: OptionType.String,
      name: 'token',
      description: 'The stablecoin you want to receive',
      required: true,
      choices: [
        { name: "The server's payout token (the default)", value: 'default' },
        ...PREFERRED_TOKENS[network].map((t) => ({ name: TOKEN_SYMBOLS[t] ?? t, value: t })),
      ],
    },
  ],
})

/**
 * The slash commands, as JSON for `PUT /applications/{id}/commands`. /rolepay is visible
 * to Manage Server by default (admins can grant it to the Treasurer role in Server
 * Settings > Integrations); the handlers re-check permissions regardless. The dev shortcut
 * options exist only when `devShortcuts` is on, and `run_now` and `veto_minutes` only when
 * `demoControls` is on (the handlers refuse them otherwise anyway).
 */
export const commandDefinitions = (opts: { devShortcuts: boolean; demoControls: boolean; network?: NetworkName }) => [
  {
    name: 'rolepay',
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
              { name: 'Sponsored (the testnet default)', value: 'sponsor' },
              { name: 'From a fee budget the bot key carries (the mainnet default)', value: 'fee_budget' },
            ],
          },
          { type: OptionType.String, name: 'fee_token', description: 'Fee budget token address (default: pathUSD)' },
          { type: OptionType.String, name: 'token', description: 'Payout token address, the first time (default: AlphaUSD on testnet, USDC.e on mainnet)' },
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
      policyGroup(opts),
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
    options: [
      { type: OptionType.SubCommand, name: 'link', description: 'Get your one-time link to register the account you are paid at' },
      payeePrefer(opts.network ?? 'moderato'),
    ],
  },
]

/** The production commands: no dev shortcuts, no demo controls. */
export const COMMAND_DEFINITIONS = commandDefinitions({ devShortcuts: false, demoControls: false })
