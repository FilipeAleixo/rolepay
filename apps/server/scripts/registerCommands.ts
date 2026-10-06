// pnpm register-commands: PUTs payrun's slash commands to Discord.
// With DISCORD_DEV_GUILD_ID set they appear in that server at once; without it, globally.
import { loadEnvironment } from '../src/env.js'
import { registerCommands } from '../src/registerCommands.js'

const result = await registerCommands(loadEnvironment())
if (result.ok) {
  console.log(`Registered ${result.value.count} commands (${result.value.scope}).`)
} else {
  const { code, detail } = result.error
  console.error(code === 'missing_env' ? `Missing in .env: ${detail}` : code === 'invalid_env' ? detail : `Discord refused: ${detail}`)
  process.exit(1)
}
