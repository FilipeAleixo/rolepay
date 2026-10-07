import { type Result, devShortcutsEnabled, err, ok } from '@rolepay/core'
import { FetchDiscordRest, commandDefinitions } from '@rolepay/discord'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Registers (overwrites) payrun's slash commands. With DISCORD_DEV_GUILD_ID they are
 * registered for that one server and show up at once; otherwise globally.
 * Needs only DISCORD_APP_ID and DISCORD_BOT_TOKEN, so it works before the rest is configured.
 * The dev shortcut options are registered only with PAYRUN_DEV_SHORTCUTS=true on testnet.
 */
export async function registerCommands(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): Promise<Result<{ count: number; scope: string }, { code: 'missing_env' | 'invalid_env' | 'discord_refused'; detail: string }>> {
  const missing = ['DISCORD_APP_ID', 'DISCORD_BOT_TOKEN'].filter((k) => !env[k])
  if (missing.length) return err({ code: 'missing_env', detail: missing.join(', ') })
  let devShortcuts: boolean
  try {
    devShortcuts = devShortcutsEnabled(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')))
  } catch (e) {
    return err({ code: 'invalid_env', detail: e instanceof Error ? e.message : String(e) })
  }
  const commands = commandDefinitions({ devShortcuts })
  const applicationId = env.DISCORD_APP_ID as string
  const guildId = env.DISCORD_DEV_GUILD_ID || undefined
  const rest = new FetchDiscordRest({ botToken: env.DISCORD_BOT_TOKEN as string, ...(fetch ? { fetch } : {}) })
  const put = await rest.putCommands({ applicationId, commands, ...(guildId ? { guildId } : {}) })
  if (!put.ok) {
    const status = put.error.code === 'http_error' ? put.error.status : put.error.code === 'forbidden' ? 403 : 404
    return err({ code: 'discord_refused', detail: `HTTP ${status} (check DISCORD_APP_ID and DISCORD_BOT_TOKEN)` })
  }
  return ok({ count: commands.length, scope: guildId ? `guild ${guildId}` : 'global' })
}
