import type { AutocompleteHandler } from '../app/handlers.js'
import { canOperate } from '../app/permissions.js'
import { runSummary } from '../views/status.js'

/** Autocomplete for the `run` option: the 25 most recent runs, filtered by what was typed. */
export const runChoices: AutocompleteHandler = async ({ options, ctx, focused }, { rolepay }) => {
  const community = await rolepay.communities.get(ctx.guildId)
  if (focused !== 'run' || !community.ok || !canOperate(ctx.caller, community.value)) return { kind: 'choices', choices: [] }
  const typed = String(options.run ?? '').trim().toLowerCase()
  const runs = await rolepay.payRuns.list({ guildId: ctx.guildId, limit: 25 })
  const choices = runs
    .filter((r) => !typed || r.id.toLowerCase().includes(typed) || (r.note ?? '').toLowerCase().includes(typed))
    .map((r) => ({ name: runSummary(r).slice(0, 100), value: r.id }))
  return { kind: 'choices', choices }
}
