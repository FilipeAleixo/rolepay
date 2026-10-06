// pnpm register-commands: PUTs payrun's slash commands to Discord.
// With DISCORD_DEV_GUILD_ID set they appear in that server at once; without it, globally.
import { loadEnvironment } from '../src/env.js'
import { registerCommands } from '../src/registerCommands.js'

const result = await registerCommands(loadEnvironment())
if (result.ok) {
  console.log(`Registered ${result.value.count} commands (${result.value.scope}).`)
} else {
  console.error(result.error.code === 'missing_env' ? `Missing in .env: ${result.error.detail}` : `Discord refused: ${result.error.detail}`)
  process.exit(1)
}
