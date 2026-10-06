import { keyValueContract } from '../../../test/support/keyValueContract.js'
import { MemoryKeyValueStore } from './keyValue.js'

keyValueContract('memory', async (clock) => new MemoryKeyValueStore(clock))
