import type { NetworkName, Payrun, Run } from '@rolepay/core'
import type { DiscordRest } from '../ports.js'
import { receiptDm } from '../views/run.js'

/** DMs each payee their receipt, one at a time (DM channel creation is rate limited). Returns how many arrived. */
export async function sendReceipts(deps: { payrun: Payrun; rest: DiscordRest; network: NetworkName }, run: Run): Promise<number> {
  const community = await deps.payrun.communities.get(run.communityId)
  const communityName = community.ok ? community.value.name : null
  let sent = 0
  for (const line of run.lines) {
    try {
      if ((await deps.rest.sendDm(line.payeeDiscordId, receiptDm(run, line, { network: deps.network, communityName }))).ok) sent++
    } catch {
      // A failed receipt never fails the run; it is counted as not delivered.
    }
  }
  return sent
}
