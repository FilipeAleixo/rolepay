// The bot key's authorisation as one direct call to the Account Keychain precompile, made by the
// root (the treasurer's passkey). viem's accessKey.authorize instead signs a key authorization
// and then the transaction that carries it: two passkey prompts for one action. A root may call
// authorizeKey itself (docs/tempo/protocol_transactions_AccountKeychain.md), and the protocol
// runs the same function for a signed key authorization, so the result on chain is the same
// with one signature.
import { Abis, Addresses } from 'viem/tempo'
import { encodeFunctionData, toFunctionSelector } from 'viem/utils'

/**
 * A key authorisation on the wire (amounts as decimal micro-unit strings). The page builds its
 * own from the form (`buildAuthorization`) and signs that one; the server's copy is only checked
 * against it (`authorizationMismatch`), never signed.
 */
export type WireAuthorization = {
  expiry: number
  limits: { token: string; limit: string; period?: number }[]
  scopes: { address: string; selector: string; recipients?: string[] }[]
}

type Hex = `0x${string}`

/** IAccountKeychain.SignatureType: the bot's key is secp256k1. */
const SECP256K1 = 0

/** A selector as given (0x and 4 bytes) or a function signature, as ox's KeyAuthorization takes it. */
const selectorOf = (s: string) => (s.startsWith('0x') ? s : toFunctionSelector(s)) as Hex

/** Flat scopes grouped by contract, the shape authorizeKey takes (ox groups them the same way). */
function allowedCalls(scopes: WireAuthorization['scopes']) {
  const byTarget = new Map<string, { selector: Hex; recipients: Hex[] }[]>()
  for (const s of scopes) {
    const rules = byTarget.get(s.address) ?? []
    rules.push({ selector: selectorOf(s.selector), recipients: (s.recipients ?? []) as Hex[] })
    byTarget.set(s.address, rules)
  }
  return [...byTarget].map(([target, selectorRules]) => ({ target: target as Hex, selectorRules }))
}

/** `authorizeKey(keyId, signatureType, KeyRestrictions)` for writeContract, signed by the root. */
export function authorizeKeyCall(keyAddress: string, auth: WireAuthorization) {
  return {
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'authorizeKey',
    args: [
      keyAddress as Hex,
      SECP256K1,
      {
        expiry: BigInt(auth.expiry),
        enforceLimits: true,
        limits: auth.limits.map((l) => ({ token: l.token as Hex, amount: BigInt(l.limit), period: BigInt(l.period ?? 0) })),
        allowAnyCalls: false,
        allowedCalls: allowedCalls(auth.scopes),
      },
    ],
  } as const
}

/** `revokeKey(keyId)`: the key can never sign for the account again (a revoked key ID never returns). */
export function revokeKeyCall(keyAddress: string) {
  return { address: Addresses.accountKeychain, abi: Abis.accountKeychain, functionName: 'revokeKey', args: [keyAddress as Hex] } as const
}

/**
 * Replacing the bot key, as the calls of ONE Tempo transaction from the root: revoke every key
 * still live on chain, then authorise the new one. Atomic (if any call reverts, none happen) and
 * one signature, so one passkey prompt, and no old key is ever left spendable.
 */
export function rotationCalls(keyAddress: string, auth: WireAuthorization, revoke: readonly string[]): { to: Hex; data: Hex }[] {
  const asCall = (c: { address: Hex; abi: unknown; functionName: string; args: readonly unknown[] }) => ({ to: c.address, data: encodeFunctionData(c as never) })
  return [...revoke.map((k) => asCall(revokeKeyCall(k))), asCall(authorizeKeyCall(keyAddress, auth))]
}

// ---- what the treasurer signs: built here from the form, never taken from the server ----------

const DAY = 86_400
const MAX_DAYS = 366
/** The only call the bot key may make (core's TRANSFER_WITH_MEMO_SIGNATURE). */
export const TRANSFER_WITH_MEMO = 'transferWithMemo(address,uint256,bytes32)'
/** With preferred stablecoins on, the one DEX call the key may make too (core's SWAP_EXACT_AMOUNT_OUT_SIGNATURE). */
export const SWAP_EXACT_AMOUNT_OUT = 'swapExactAmountOut(address,address,uint128,uint128)'
/** Tempo's stablecoin exchange, lowercase like every address the page compares. */
const STABLECOIN_DEX = Addresses.stablecoinDex.toLowerCase()

export type KeyForm = { limit: string; periodDays: string; validityDays: string; feeBudget?: string }
/**
 * From the page config: the payout token, and the fee token in fee budget mode (null when sponsored).
 * `swapTokens`: with preferred stablecoins on, the tokens the key may swap into and deliver (from the
 * page config, as core's swapTokensFor lists them); absent, null or empty when they are off.
 */
export type KeyPage = { payoutToken: string; feeToken: string | null; swapTokens?: readonly string[] | null }
type Built = { ok: true; value: WireAuthorization } | { ok: false; error: string }

/** A plain positive decimal amount with at most 6 decimals, to micro-units, without floats. null otherwise. */
export function parseMicros(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text)
  if (!m) return null
  const value = BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))
  return value > 0n ? value : null
}

function days(text: string, min: number): number | null {
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= MAX_DAYS ? n : null
}

/**
 * The authorisation the treasurer means, from what they typed and the page config: their limit
 * and period, an expiry from this device's clock, and only transferWithMemo on the payout token.
 */
export function buildAuthorization(form: KeyForm, page: KeyPage, nowSeconds: number): Built {
  const limit = parseMicros(form.limit)
  if (limit === null) return { ok: false, error: `"${form.limit}" is not an amount: use a number like 100 or 12.5` }
  const period = days(form.periodDays, 0)
  if (period === null) return { ok: false, error: `the reset period must be a whole number of days from 0 to ${MAX_DAYS}` }
  const validity = days(form.validityDays, 1)
  if (validity === null) return { ok: false, error: `the expiry must be a whole number of days from 1 to ${MAX_DAYS}` }
  const every = period === 0 ? {} : { period: period * DAY }
  const limits: WireAuthorization['limits'] = [{ token: page.payoutToken, limit: limit.toString(), ...every }]
  if (page.feeToken) {
    const fee = parseMicros(form.feeBudget ?? '')
    if (fee === null) return { ok: false, error: 'the fee budget must be an amount, for example 1' }
    limits.push({ token: page.feeToken, limit: fee.toString(), ...every })
  }
  const scopes: WireAuthorization['scopes'] = [{ address: page.payoutToken, selector: TRANSFER_WITH_MEMO }]
  // Preferred stablecoins (core's preferredTokenGrants): the exact-output swap, and transferWithMemo on
  // each token, each limited like the payout token, appended in the same order core appends them.
  const swaps = page.swapTokens ?? []
  if (swaps.length) {
    limits.push(...swaps.map((token) => ({ token, limit: limit.toString(), ...every })))
    scopes.push({ address: STABLECOIN_DEX, selector: SWAP_EXACT_AMOUNT_OUT }, ...swaps.map((address) => ({ address, selector: TRANSFER_WITH_MEMO })))
  }
  return { ok: true, value: { expiry: nowSeconds + validity * DAY, limits, scopes } }
}

const lc = (s: string) => s.toLowerCase()

/**
 * What differs between the authorisation the page built and the one the server returned, in
 * words, or null when they are the same on chain. The server's copy is untrusted JSON.
 */
export function authorizationMismatch(mine: WireAuthorization, theirs: WireAuthorization): string | null {
  try {
    const limits = (a: WireAuthorization) => JSON.stringify(a.limits.map((l) => [lc(l.token), BigInt(l.limit).toString(), l.period ?? 0]))
    const scopes = (a: WireAuthorization) =>
      JSON.stringify(allowedCalls(a.scopes.map((s) => ({ ...s, address: lc(s.address), recipients: (s.recipients ?? []).map(lc) }))))
    if (theirs.expiry !== mine.expiry) return 'a different expiry'
    if (limits(theirs) !== limits(mine)) return 'different spending limits'
    if (scopes(theirs) !== scopes(mine)) return 'different allowed calls'
    return null
  } catch {
    return 'a shape this page cannot read'
  }
}

/** Exactly what the treasurer is about to sign, in plain words (shown above the button). */
export function describeAuthorization(a: WireAuthorization, f: { label: (token: string) => string; date: (unixSeconds: number) => string }): string {
  const every = (period?: number) =>
    !period ? 'in total' : period % DAY === 0 ? (period === DAY ? 'every day' : `every ${period / DAY} days`) : `every ${period} seconds`
  const amount = (micro: string) => {
    const v = BigInt(micro)
    const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    return frac ? `${v / 1_000_000n}.${frac}` : `${v / 1_000_000n}`
  }
  // The first limit is the payout token's; a limit on a token the key may not call is the fee budget;
  // the others are the preferred stablecoins the key may deliver.
  const [spend, ...rest] = a.limits
  const callable = (token: string) => a.scopes.some((s) => s.address.toLowerCase() === token.toLowerCase())
  const fees = rest.filter((l) => !callable(l.token))
  const swaps = rest.filter((l) => callable(l.token))
  const parts = [spend ? `Up to ${amount(spend.limit)} ${f.label(spend.token)} ${every(spend.period)}` : 'No spending at all']
  for (const fee of fees) parts.push(`plus up to ${amount(fee.limit)} ${f.label(fee.token)} ${every(fee.period)} for fees`)
  if (swaps.length) parts.push(`plus ${swaps.map((l) => `up to ${amount(l.limit)} ${f.label(l.token)}`).join(' and ')} ${every(swaps[0]?.period)} to pay people who chose them`)
  const calls = a.scopes.map((s) => {
    if (s.selector === SWAP_EXACT_AMOUNT_OUT) return `Only swapExactAmountOut on ${f.label(s.address)} (${s.address}), buying exactly what a run pays out`
    const name = s.selector === TRANSFER_WITH_MEMO ? 'transferWithMemo' : s.selector
    const to = s.recipients?.length ? `only to ${s.recipients.join(', ')}` : 'to anyone'
    return `Only ${name} on ${f.label(s.address)} (${s.address}), ${to}`
  })
  return `${parts.join(', ')}. ${calls.join('. ')}. Expires ${f.date(a.expiry)}.`
}
