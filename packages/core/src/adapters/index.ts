/**
 * `@rolepay/core/adapters`: concrete implementations of the ports, for composition roots
 * (apps/server, CLIs, chain tests) only. Services never import these.
 */
export { AnthropicRunProposer, type AnthropicRunProposerOptions, DEFAULT_AI_MODEL } from './anthropic/index.js'
export { AesGcmKeyVault, RandomIds, SystemClock } from './crypto/index.js'
export {
  FakeActivityReader,
  FakePayoutChain,
  FakeRunProposer,
  ManualClock,
  MemoryKeyValueStore,
  PlainKeyVault,
  SequentialIds,
  createMemoryRepositories,
  emptyCriteria,
  naiveMessageProposal,
  unclearCriteria,
} from './memory/index.js'
export { KvProposalRepository } from './kv/proposals.js'
export { DailyCappedProposer } from './kv/proposerDailyCap.js'
export { KvRunLeases } from './kv/runLeases.js'
export { openSqliteDatabase } from './sqlite/index.js'
export {
  TempoPayoutChain,
  type TempoPayoutChainOptions,
  createTestnetTools,
  idempotentSend,
  rootSignerFromPrivateKey,
} from './tempo/index.js'
export { openRolepayAdapters } from './wiring.js'
