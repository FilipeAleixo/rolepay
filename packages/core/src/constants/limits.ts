/**
 * Tempo caps one transaction at 30M gas (docs/tempo/guide_node_network-upgrades.md, T1A).
 * A first transfer to a fresh address costs about 250-300k gas (spike RESULTS.md), so
 * ~100 lines is the theoretical ceiling; 50 keeps a 2x margin. Raise only after a
 * chain test at the new size.
 */
export const MAX_LINES_PER_RUN = 50

/** Free-text note on a run (shown in Discord and in the CSV). */
export const MAX_NOTE_LENGTH = 200

/**
 * AI-proposed pay runs. A proposal never pays anyone: it becomes a normal run (at most
 * MAX_LINES_PER_RUN lines) that the treasurer approves. These bound what one proposal reads.
 */
export const PROPOSAL_LIMITS = {
  /** Criteria mode: how far back channel history is read, in days. */
  maxLookbackDays: 31,
  /** Criteria mode: messages read per proposal, across every channel and thread it scans. */
  maxScannedMessages: 10_000,
  /** Criteria mode: distinct channels one proposal may count in. */
  maxChannels: 5,
  /** Message mode: the newest messages of a channel or thread that go to the model. */
  maxSourceMessages: 200,
  /** Message mode: characters of one message's text that go to the model. */
  maxMessageChars: 2000,
  /** The instruction typed by the proposer. */
  maxInstructionLength: 1000,
  /** Criteria mode: people seen in the activity who are not registered payees, looked up and listed. */
  maxUnregisteredCandidates: 100,
  /** A proposal stays open for a day, then it is gone (nothing was created from it). */
  ttlSeconds: 86_400,
} as const

/**
 * Standing policies: the AI writes the rule once, a treasurer approves it, code runs it on a
 * schedule, the bot key's limit caps it on chain.
 */
export const POLICY_LIMITS = {
  maxNameLength: 80,
  /** Autopilot: how long a run waits for a veto before it pays. Default 24 h, at least 1 h. */
  defaultVetoMinutes: 24 * 60,
  minVetoMinutes: 60,
  maxVetoMinutes: 7 * 24 * 60,
  /** A scheduler instance that claimed a run (or its release) holds it this long; then another may take over. */
  leaseSeconds: 300,
  /** People just below the line, shown with a preview. */
  maxNearMisses: 10,
  /** Matched people who are not registered payees, kept with a run. */
  maxUnregistered: 100,
} as const
