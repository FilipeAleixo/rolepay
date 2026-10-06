import { repositoryContracts } from '../../../test/support/repositoryContracts.js'
import { createMemoryRepositories } from './repositories.js'

repositoryContracts('memory', async () => createMemoryRepositories())
