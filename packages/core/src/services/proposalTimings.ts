import type { ActivityReader } from '../ports/activityReader.js'
import type { Clock } from '../ports/clock.js'
import type { ProposalTimings } from '../ports/proposalLog.js'

type Phase = Exclude<keyof ProposalTimings, 'totalMs'>

/** Times one proposal, phase by phase, on the service's clock (for the proposal log line). */
export type Stopwatch = {
  time<T>(phase: Phase, work: () => Promise<T>): Promise<T>
  done(): ProposalTimings
}

export function stopwatch(clock: Clock): Stopwatch {
  const ms = () => clock.now().getTime()
  const started = ms()
  const spent: Record<Phase, number> = { discordMs: 0, chainMs: 0, modelMs: 0 }
  return {
    async time(phase, work) {
      const t = ms()
      try {
        return await work()
      } finally {
        spent[phase] += ms() - t
      }
    },
    done: () => ({ ...spent, totalMs: ms() - started }),
  }
}

/** The activity reader, with every read counted as Discord time. */
export function timedActivity(reader: ActivityReader, watch: Stopwatch): ActivityReader {
  return {
    guildNames: (guildId) => watch.time('discordMs', () => reader.guildNames(guildId)),
    members: (guildId, userIds) => watch.time('discordMs', () => reader.members(guildId, userIds)),
    history: (input) => watch.time('discordMs', () => reader.history(input)),
    message: (input) => watch.time('discordMs', () => reader.message(input)),
    reactions: (input) => watch.time('discordMs', () => reader.reactions(input)),
  }
}
