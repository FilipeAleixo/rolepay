import type { NetworkName, Rolepay, Run } from '@rolepay/core'
import type { DiscordRest } from '../ports.js'
import { receiptDm } from '../views/run.js'

/** Where receipts link to: the network's explorer, and the server's account page (where a payee sees and moves the money), if any. */
export type ReceiptDeps = { rolepay: Rolepay; rest: DiscordRest; network: NetworkName; accountUrl?: string | null }

/**
 * DMs each payee their receipt, one at a time (DM channel creation is rate limited). Returns how many
 * arrived. Each receipt's account link fits the line's address: the account page while it is the
 * payee's passkey account, the explorer when it is their own wallet, or an address they have moved
 * from since (Rolepay no longer knows what it is).
 */
export async function sendReceipts(deps: ReceiptDeps, run: Run): Promise<number> {
  const community = await deps.rolepay.communities.get(run.communityId)
  const communityName = community.ok ? community.value.name : null
  let sent = 0
  for (const line of run.lines) {
    try {
      const payee = await deps.rolepay.payees.get({ guildId: run.communityId, discordUserId: line.payeeDiscordId })
      const addressKind = payee.ok && payee.value.address === line.address ? payee.value.addressKind : null
      if ((await deps.rest.sendDm(line.payeeDiscordId, receiptDm(run, line, { network: deps.network, communityName, accountUrl: deps.accountUrl ?? null, addressKind }))).ok) sent++
    } catch {
      // A failed receipt never fails the run; it is counted as not delivered.
    }
  }
  return sent
}
