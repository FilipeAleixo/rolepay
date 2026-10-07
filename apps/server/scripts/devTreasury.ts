// pnpm dev:treasury (TESTNET ONLY, with ROLEPAY_DEV_SHORTCUTS=true): prints the dev treasury address and tops it up from
// the Moderato faucet. The treasury key is ROLEPAY_TEST_ROOT_PRIVATE_KEY in the gitignored
// .env (the chain test generates it); if it is missing, a throwaway one is generated there.
// The key itself is never printed.
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NETWORKS, TESTNET_TOKENS, formatAmount, parseConfig } from '@rolepay/core'
import { createTestnetTools, rootSignerFromPrivateKey } from '@rolepay/core/adapters'
import { requireDevShortcuts } from '../src/devShortcuts.js'
import { REPO_ROOT, loadEnvironment } from '../src/env.js'

const env = loadEnvironment()
const config = parseConfig(env)
requireDevShortcuts(config, 'dev:treasury')

let key = env.ROLEPAY_TEST_ROOT_PRIVATE_KEY
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  key = `0x${randomBytes(32).toString('hex')}`
  const path = join(REPO_ROOT, '.env')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  appendFileSync(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}ROLEPAY_TEST_ROOT_PRIVATE_KEY=${key}\n`, { mode: 0o600 })
  console.log('Generated a throwaway testnet treasury key into .env (ROLEPAY_TEST_ROOT_PRIVATE_KEY).')
}

const treasury = rootSignerFromPrivateKey(key as `0x${string}`).address
const token = TESTNET_TOKENS.alpha_usd
const tools = createTestnetTools({ rpcUrl: config.rpcUrl })
await tools.ensureFunded(treasury, token, 100_000_000n)
const balance = await tools.balance(token, treasury)
console.log(`Dev treasury: ${treasury}`)
console.log(`AlphaUSD balance: ${formatAmount(balance)}`)
console.log(`Explorer: ${NETWORKS.moderato.explorerUrl}/address/${treasury}`)
console.log(`Use it in Discord: /payrun setup treasury:${treasury} approver_role:@Treasurer`)
