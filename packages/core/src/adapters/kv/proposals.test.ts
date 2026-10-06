import { proposalRepositoryContract } from '../../../test/support/proposalRepositoryContract.js'
import { MemoryKeyValueStore } from '../memory/keyValue.js'
import { KvProposalRepository } from './proposals.js'

proposalRepositoryContract('memory', async (clock) => new KvProposalRepository(new MemoryKeyValueStore(clock), clock))
