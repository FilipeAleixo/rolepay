import { describe, expect, it } from 'vitest'
import { errorFields } from './logging.js'

describe('errorFields (what a logged error carries)', () => {
  it('keeps the message but never a URL, which for an RPC or relay can hold an API key', () => {
    const viemError = new Error('HTTP request failed.\n\nURL: https://rpc.example.org/v1/sk_live_abc123\nRequest body: {"method":"eth_getLogs"}')
    const fields = errorFields(viemError)
    expect(fields.error).toContain('HTTP request failed')
    expect(fields.error).not.toContain('sk_live_abc123')
    expect(fields.error).toContain('<url>')
    expect(errorFields('plain string')).toEqual({ error: 'plain string' })
  })
})
