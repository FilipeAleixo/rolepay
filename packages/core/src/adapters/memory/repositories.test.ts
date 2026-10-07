import { fundingRepositoryContract } from '../../../test/support/fundingRepositoryContract.js'
import { policyRepositoryContract } from '../../../test/support/policyRepositoryContract.js'
import { repositoryContracts } from '../../../test/support/repositoryContracts.js'
import { createMemoryRepositories } from './repositories.js'

repositoryContracts('memory', async () => createMemoryRepositories())
policyRepositoryContract('memory', async () => createMemoryRepositories())
fundingRepositoryContract('memory', async () => createMemoryRepositories())
