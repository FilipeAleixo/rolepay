import { describe, expect, it } from 'vitest'
import { AddressSchema, DiscordIdSchema, RunIdSchema } from './ids.js'

describe('AddressSchema', () => {
  it('normalises to lowercase (the form stored and compared everywhere)', () => {
    expect(AddressSchema.parse('0xAbCdEf0000000000000000000000000000000001')).toBe('0xabcdef0000000000000000000000000000000001')
  })

  it.each([
    '0x0000000000000000000000000000000000000000',
    '0x123',
    'abcdef0000000000000000000000000000000001',
    '0xabcdef000000000000000000000000000000000g',
    '0xabcdef00000000000000000000000000000000011',
  ])('rejects %s', (input) => {
    expect(AddressSchema.safeParse(input).success).toBe(false)
  })
})

describe('DiscordIdSchema (snowflake)', () => {
  it('accepts a 17-20 digit snowflake string', () => {
    expect(DiscordIdSchema.parse('1094309218049937418')).toBe('1094309218049937418')
  })

  it.each(['', '123', 'abc1094309218049937', '109430921804993741812345', 1094309218049937418])('rejects %j', (input) => {
    expect(DiscordIdSchema.safeParse(input).success).toBe(false)
  })
})

describe('RunIdSchema', () => {
  it('accepts memo-safe IDs only', () => {
    expect(RunIdSchema.safeParse('run_0123456789abcdef').success).toBe(true)
    expect(RunIdSchema.safeParse('x'.repeat(25)).success).toBe(false)
    expect(RunIdSchema.safeParse('has space').success).toBe(false)
  })
})
