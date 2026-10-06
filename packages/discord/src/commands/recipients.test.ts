import { describe, expect, it } from 'vitest'
import { parseRecipients } from './recipients.js'

const A = '200000000000000001'
const B = '200000000000000002'

describe('parseRecipients', () => {
  it('reads user mentions (with or without !) and raw IDs, in order', () => {
    expect(parseRecipients(`<@${A}> <@!${B}>`)).toEqual({ ok: true, value: [{ userId: A, amount: null }, { userId: B, amount: null }] })
    expect(parseRecipients(`${A}, ${B}`)).toEqual({ ok: true, value: [{ userId: A, amount: null }, { userId: B, amount: null }] })
  })

  it('reads a per-person amount after = or :, attached or spaced', () => {
    expect(parseRecipients(`<@${A}>=40 <@${B}> : 12.5`)).toEqual({
      ok: true,
      value: [
        { userId: A, amount: 40_000_000n },
        { userId: B, amount: 12_500_000n },
      ],
    })
  })

  it('rejects role mentions, junk, bad amounts and duplicates, naming each problem', () => {
    const r = parseRecipients(`<@&400000000000000001> hello <@${A}>=1.0000001 <@${B}> <@${B}>`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.issues).toEqual([
      'users: roles go in the role option, not in users',
      'users: "hello" is not a user mention',
      `users: the amount for <@${A}> is not valid (too_many_decimals)`,
      `users: <@${B}> is listed twice`,
    ])
  })

  it('an amount with nobody before it is an error', () => {
    expect(parseRecipients('=40').ok).toBe(false)
  })

  it('empty text means nobody', () => {
    expect(parseRecipients('   ')).toEqual({ ok: true, value: [] })
  })
})
