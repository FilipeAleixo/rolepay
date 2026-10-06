/**
 * Tempo caps one transaction at 30M gas (docs/tempo/guide_node_network-upgrades.md, T1A).
 * A first transfer to a fresh address costs about 250-300k gas (spike RESULTS.md), so
 * ~100 lines is the theoretical ceiling; 50 keeps a 2x margin. Raise only after a
 * chain test at the new size.
 */
export const MAX_LINES_PER_RUN = 50

/** Free-text note on a run (shown in Discord and in the CSV). */
export const MAX_NOTE_LENGTH = 200
