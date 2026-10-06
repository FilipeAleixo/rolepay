export interface IdGenerator {
  /** A new run ID. Must fit the memo scheme (1-24 printable ASCII chars). */
  runId(): string
  /** A new one-time link token: unguessable, URL-safe, at least 128 bits of entropy. */
  linkToken(): string
  /** A new proposal ID: 1-40 chars of [A-Za-z0-9_] (it goes into button IDs). */
  proposalId(): string
}
