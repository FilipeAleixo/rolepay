/**
 * Pay-run memo layout, one bytes32 per payout line (TIP-20 `transferWithMemo`):
 *
 *   bytes 0-1   magic "PR"
 *   byte  2     version (0x01)
 *   byte  3     reserved (0x00)
 *   bytes 4-27  run ID, printable ASCII, right-padded with 0x00 (max 24 chars)
 *   bytes 28-31 line number, uint32 big-endian (1-based in pay runs)
 *
 * The memo is an indexed topic on `TransferWithMemo`, so "was line N of run R
 * paid?" is one RPC log filter. Changing this layout orphans every past run's
 * reconciliation: bump MEMO_VERSION instead.
 */
export const MEMO_MAGIC = [0x50, 0x52] as const // "PR"
export const MEMO_VERSION = 0x01
export const MEMO_BYTES = 32
export const MAX_RUN_ID_LENGTH = 24
