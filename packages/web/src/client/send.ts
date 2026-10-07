// What the account page lets a payee send from their own passkey account. Pure, so the rules are
// tested without a browser or a chain. The payee's passkey signs; Rolepay's server is not involved.
import { formatMicros } from './dom.js'
import { FEE_RESERVE } from './fees.js'
import { parseMicros } from './keychain.js'

type Checked = { ok: true; value: { to: `0x${string}`; amount: bigint } } | { ok: false; error: string }

/** TIP-20 token contracts live under this prefix; the protocol refuses transfers to them. */
const TIP20_PREFIX = '0x20c000000000000000000000'

/** What can be sent: everything when a sponsor pays the fee, otherwise the balance less a fee reserve (the fee comes out of the same token). */
export const maxSendable = (balance: bigint, sponsored: boolean): bigint => {
  const max = sponsored ? balance : balance - FEE_RESERVE
  return max > 0n ? max : 0n
}

/** A transfer the payee typed, or why not, in words. */
export function checkSend(input: { to: string; amount: string; from: string; balance: bigint; sponsored: boolean }): Checked {
  const to = input.to.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(to)) return { ok: false, error: 'that is not a Tempo address (0x and 40 hexadecimal characters)' }
  if (to === input.from.toLowerCase()) return { ok: false, error: 'that is this account' }
  if (/^0x0{40}$/.test(to)) return { ok: false, error: 'that is the zero address: nothing sent there can ever be moved' }
  if (to.startsWith(TIP20_PREFIX)) return { ok: false, error: 'that is a token contract, not an account: tokens cannot be sent there' }
  const text = input.amount.trim()
  const amount = parseMicros(text)
  if (amount === null) return { ok: false, error: `"${text}" is not an amount: use a number like 10 or 2.5` }
  const max = maxSendable(input.balance, input.sponsored)
  if (amount > max) {
    return {
      ok: false,
      error: input.sponsored
        ? `that is more than the balance (${formatMicros(input.balance.toString())})`
        : `that is more than you can send: keep ${formatMicros(FEE_RESERVE.toString())} for the network fee (at most ${formatMicros(max.toString())})`,
    }
  }
  return { ok: true, value: { to: to as `0x${string}`, amount } }
}
