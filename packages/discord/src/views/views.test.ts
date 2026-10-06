import { describe, expect, it } from 'vitest'
import { ADMIN, ALICE, BOB, TREASURER, TX, approved, cancelled, executing, failed, paid, pending, run } from '../../test/fixtures.js'
import { ButtonStyle, type Message } from '../api.js'
import { decodeCustomId } from '../components/customId.js'
import { explainError } from './errors.js'
import { money, shortAddress, tokenLabel } from './format.js'
import { receiptDm, runMessage } from './run.js'

const ctx = { network: 'moderato' as const }
const buttons = (m: Message) => (m.components ?? []).flatMap((row) => row.components)
const actions = (m: Message) => buttons(m).flatMap((b) => ('custom_id' in b ? [decodeCustomId(b.custom_id)?.action] : []))
const text = (m: Message) => JSON.stringify(m)

describe('format', () => {
  it('names the testnet stablecoins and shortens other addresses', () => {
    expect(tokenLabel('0x20c0000000000000000000000000000000000001')).toBe('AlphaUSD')
    expect(tokenLabel('0x20c0000000000000000000000000000000000000')).toBe('pathUSD')
    expect(tokenLabel('0xabcdef0000000000000000000000000000001234')).toBe('0xabcd…1234')
    expect(shortAddress('0x1111111111111111111111111111111111111111')).toBe('0x1111…1111')
  })

  it('prints money from bigint micro-units without floats', () => {
    expect(money(1_500_000n, '0x20c0000000000000000000000000000000000001')).toBe('1.5 AlphaUSD')
    expect(money(1n, '0x20c0000000000000000000000000000000000001')).toBe('0.000001 AlphaUSD')
  })
})

describe('runMessage', () => {
  it('a run awaiting approval lists every line and the total, with Approve and Cancel', () => {
    const m = runMessage(pending(), ctx)
    const t = text(m)
    expect(t).toContain(`<@${ALICE}>`)
    expect(t).toContain('1.5 AlphaUSD')
    expect(t).toContain(`<@${BOB}>`)
    expect(t).toContain('25 AlphaUSD')
    expect(t).toContain('26.5 AlphaUSD') // total
    expect(t).toContain('October mods')
    expect(actions(m)).toEqual(['approve', 'cancel'])
    expect(buttons(m).map((b) => b.style)).toEqual([ButtonStyle.Success, ButtonStyle.Danger])
  })

  it('never pings anyone it mentions', () => {
    for (const r of [pending(), paid(), failed()]) expect(runMessage(r, ctx).allowed_mentions).toEqual({ parse: [] })
  })

  it('an approved or executing run shows who approved it and that it is paying, with no buttons', () => {
    for (const r of [approved(), executing()]) {
      const m = runMessage(r, ctx)
      expect(text(m)).toContain(`<@${TREASURER}>`)
      expect(text(m)).toMatch(/Paying/)
      expect(buttons(m)).toEqual([])
    }
  })

  it('a paid run links the transaction on the explorer', () => {
    const m = runMessage(paid(), ctx)
    expect(text(m)).toContain(`https://explore.testnet.tempo.xyz/tx/${TX}`)
    expect(actions(m)).toEqual([])
    expect(buttons(m).some((b) => b.style === ButtonStyle.Link)).toBe(true)
  })

  it('a retryable failure explains itself and offers Retry', () => {
    const m = runMessage(failed('rejected'), ctx)
    expect(text(m)).toMatch(/refused/i)
    expect(actions(m)).toEqual(['retry', 'cancel'])
  })

  it('a failure where money may have moved offers no Retry and says a human must look', () => {
    const m = runMessage(failed('partial_match'), ctx)
    expect(text(m)).toMatch(/do not retry/i)
    expect(actions(m)).toEqual([])
  })

  it('a cancelled run says who cancelled it', () => {
    const m = runMessage(cancelled(), ctx)
    expect(text(m)).toContain(`<@${ADMIN}>`)
    expect(text(m)).toMatch(/Cancelled/)
    expect(buttons(m)).toEqual([])
  })

  it('an approved run that could not start shows the problem and offers Retry', () => {
    const m = runMessage(approved(), { ...ctx, problem: 'The bot key was revoked.' })
    expect(text(m)).toContain('The bot key was revoked.')
    expect(text(m)).not.toMatch(/Paying/)
    expect(actions(m)).toEqual(['retry', 'cancel'])
  })

  it('a run without a note still renders', () => {
    expect(() => runMessage(run({ note: null }), ctx)).not.toThrow()
  })
})

describe('receiptDm', () => {
  it('tells the payee what they were paid, why, and links the transaction', () => {
    const r = paid()
    const m = receiptDm(r, r.lines[1] as (typeof r.lines)[number], { ...ctx, communityName: 'Test guild' })
    const t = text(m)
    expect(t).toContain('25 AlphaUSD')
    expect(t).toContain('October mods')
    expect(t).toContain('Test guild')
    expect(t).toContain(`https://explore.testnet.tempo.xyz/tx/${TX}`)
  })
})

describe('explainError', () => {
  it('turns core error codes into plain English', () => {
    expect(explainError({ code: 'community_not_found' })).toMatch(/\/payrun setup/)
    expect(explainError({ code: 'unregistered_payees', discordUserIds: [ALICE, BOB] })).toContain(`<@${ALICE}>, <@${BOB}>`)
    expect(explainError({ code: 'unregistered_payees', discordUserIds: [ALICE] })).toMatch(/\/payee link/)
    expect(explainError({ code: 'insufficient_limit', remaining: 2_000_000n, needed: 26_500_000n, periodEnd: 1_800_000_000 }, { token: '0x20c0000000000000000000000000000000000001' })).toBe(
      'This run needs 26.5 AlphaUSD but the bot key has 2 AlphaUSD left this period (it resets <t:1800000000:R>).',
    )
    expect(explainError({ code: 'key_revoked' })).toMatch(/revoked/)
    expect(explainError({ code: 'invalid_input', issues: ['amount: too small'] })).toContain('amount: too small')
  })

  it('never fails on an unknown code', () => {
    expect(explainError({ code: 'brand_new_code' })).toMatch(/brand_new_code/)
  })
})
