import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { authorizeKeyCall } from './keychain.js'

const TOKEN = '0x20c0000000000000000000000000000000000001'
const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'
const KEY = '0x1111111111111111111111111111111111111111'
const TRANSFER_WITH_MEMO = toFunctionSelector('transferWithMemo(address,uint256,bytes32)')
/** Decoded addresses come back checksummed. */
const T = getAddress(TOKEN)
const F = getAddress(FEE_TOKEN)

const decoded = (call: ReturnType<typeof authorizeKeyCall>) =>
  decodeFunctionData({ abi: Abis.accountKeychain, data: encodeFunctionData(call as never) })

describe('authorizeKeyCall: the root calls the Account Keychain directly, so one transaction signature is the only passkey prompt', () => {
  it('calls the current authorizeKey(keyId, signatureType, KeyRestrictions) on the keychain, never the legacy selector', () => {
    const call = authorizeKeyCall(KEY, { expiry: 1_900_000_000, limits: [{ token: TOKEN, limit: '5000000' }], scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }] })
    expect(call.address).toBe(Addresses.accountKeychain)
    expect(encodeFunctionData(call as never).slice(0, 10)).toBe(
      toFunctionSelector('authorizeKey(address,uint8,(uint64,bool,(address,uint256,uint64)[],bool,(address,(bytes4,address[])[])[]))'),
    )
  })

  it('keeps the limit, the period, the expiry and the scope exactly as the server returned them', () => {
    const call = authorizeKeyCall(KEY, {
      expiry: 1_900_000_000,
      limits: [{ token: TOKEN, limit: '5000000', period: 86_400 }],
      scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }],
    })
    expect(decoded(call).args).toEqual([
      KEY,
      0, // secp256k1: the bot's key
      {
        expiry: 1_900_000_000n,
        enforceLimits: true,
        limits: [{ token: T, amount: 5_000_000n, period: 86_400n }],
        allowAnyCalls: false,
        allowedCalls: [{ target: T, selectorRules: [{ selector: TRANSFER_WITH_MEMO, recipients: [] }] }],
      },
    ])
  })

  it('a one-time limit has period 0, and a fee budget is a second limit with the same period', () => {
    const once = decoded(authorizeKeyCall(KEY, { expiry: 1, limits: [{ token: TOKEN, limit: '7' }], scopes: [] })).args?.[2] as { limits: unknown }
    expect(once.limits).toEqual([{ token: T, amount: 7n, period: 0n }])
    const withFee = decoded(
      authorizeKeyCall(KEY, { expiry: 1, limits: [{ token: TOKEN, limit: '7', period: 60 }, { token: FEE_TOKEN, limit: '2', period: 60 }], scopes: [] }),
    ).args?.[2] as { limits: unknown }
    expect(withFee.limits).toEqual([
      { token: T, amount: 7n, period: 60n },
      { token: F, amount: 2n, period: 60n },
    ])
  })

  it('keeps a recipient allowlist, and groups selectors on the same contract into one call scope', () => {
    const payee = '0x2222222222222222222222222222222222222222'
    const call = authorizeKeyCall(KEY, {
      expiry: 1,
      limits: [{ token: TOKEN, limit: '1' }],
      scopes: [
        { address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)', recipients: [payee] },
        { address: TOKEN, selector: '0xa9059cbb' },
      ],
    })
    expect((decoded(call).args?.[2] as { allowedCalls: unknown }).allowedCalls).toEqual([
      {
        target: T,
        selectorRules: [
          { selector: TRANSFER_WITH_MEMO, recipients: [payee] },
          { selector: '0xa9059cbb', recipients: [] },
        ],
      },
    ])
  })
})
