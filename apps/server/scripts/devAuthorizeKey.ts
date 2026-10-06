// pnpm dev:authorize-key <guildId> (TESTNET ONLY, with PAYRUN_DEV_SHORTCUTS=true): the treasury root authorises the bot key
// that /payrun setup provisioned, signing in-process with PAYRUN_TEST_ROOT_PRIVATE_KEY.
// The production path is the treasury page: /payrun setup hands a treasurer the link, and the
// passkey signs the authorisation in the browser.
import { NETWORKS, createPayrun, parseConfig } from '@payrun/core'
import { createTestnetTools, openPayrunAdapters, rootSignerFromPrivateKey } from '@payrun/core/adapters'
import { requireDevShortcuts } from '../src/devShortcuts.js'
import { loadEnvironment } from '../src/env.js'

const guildId = process.argv[2]
if (!guildId || !/^\d{17,20}$/.test(guildId)) {
  console.error('Usage: pnpm dev:authorize-key <guildId>   (the server ID shown by /payrun setup)')
  process.exit(1)
}
const env = loadEnvironment()
const config = parseConfig(env)
requireDevShortcuts(config, 'dev:authorize-key')
const key = env.PAYRUN_TEST_ROOT_PRIVATE_KEY
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('PAYRUN_TEST_ROOT_PRIVATE_KEY is not set. Run `pnpm dev:treasury` first.')
  process.exit(1)
}
const root = rootSignerFromPrivateKey(key as `0x${string}`)

const { deps, close } = await openPayrunAdapters(config)
try {
  const payrun = createPayrun(deps)
  const community = await payrun.communities.get(guildId)
  if (!community.ok) throw new Error(`Server ${guildId} is not registered. Run /payrun setup in Discord first.`)
  if (community.value.treasuryAddress !== root.address) {
    throw new Error(`Server ${guildId} is registered with treasury ${community.value.treasuryAddress}, but the dev root key controls ${root.address}.`)
  }
  await createTestnetTools({ rpcUrl: config.rpcUrl }).ensureFunded(root.address, community.value.payoutToken, 100_000_000n)
  const result = await payrun.communities.authorizeBotKey({ guildId, root })
  if (!result.ok) {
    const hint = result.error.code === 'no_pending_key' ? ' Run /payrun setup (or /payrun setup new_key:true) to provision one.' : ''
    throw new Error(`Could not authorise: ${result.error.code}.${hint}`)
  }
  console.log(`Bot key ${result.value.key.address} is active for server ${guildId}.`)
  console.log(`Authorisation tx: ${NETWORKS.moderato.explorerUrl}/tx/${result.value.txHash}`)
  console.log('Run /payrun setup again in Discord to see it active.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await close()
}
