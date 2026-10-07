import { describe, expect, it } from 'vitest'
import { displayMicros, explainPasskeyError, formatMicros } from './dom.js'

describe('explainPasskeyError (what the page tells a person when something fails)', () => {
  it('names a closed passkey prompt plainly', () => {
    const closed = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' })
    expect(explainPasskeyError(closed)).toBe('The passkey prompt was closed before it finished. Try again.')
  })

  it('keeps the raw error (RPC URLs, request bodies) off the page: generic text, details in the console', () => {
    const rpc = Object.assign(new Error('HTTP request failed. URL: https://rpc.example.org/key-abc Request body: {"method":"eth_sendRawTransaction"}'), { name: 'HttpRequestError' })
    const text = explainPasskeyError(rpc)
    expect(text).not.toContain('rpc.example.org')
    expect(text).not.toContain('Request body')
    expect(text).toBe('Something went wrong (HttpRequestError). The details are in the browser console; try again in a moment.')
  })

  /** What the Accounts SDK throws: its RPC wrapper around the original error. */
  const wrapped = (cause: Error) => Object.assign(new Error(cause.message, { cause }), { name: 'RpcResponse.InternalError' })

  it('names a passkey the server does not know (remembered from before a reset) plainly', () => {
    expect(explainPasskeyError(wrapped(new Error('Unknown credential')))).toBe(
      'This server does not know that passkey (it may be from before the server was reset). Create a new passkey, or sign in with another one.',
    )
  })

  it("never shows the SDK's wrapper name: the wrapped error's own name, or none", () => {
    expect(explainPasskeyError(wrapped(new Error('Request failed')))).toBe('Something went wrong. The details are in the browser console; try again in a moment.')
    expect(explainPasskeyError(wrapped(Object.assign(new Error('fetch failed'), { name: 'TypeError' })))).toBe(
      'Something went wrong (TypeError). The details are in the browser console; try again in a moment.',
    )
    expect(explainPasskeyError(Object.assign(new Error('no cause'), { name: 'RpcResponse.InternalError' }))).toBe('Something went wrong. The details are in the browser console; try again in a moment.')
  })
})

describe('displayMicros (money for reading on the setup and account pages)', () => {
  it('groups thousands with commas and keeps up to 6 decimals trimmed', () => {
    expect(displayMicros('999995000000')).toBe('999,995')
    expect(displayMicros('1234567890000')).toBe('1,234,567.89')
    expect(displayMicros('999000000')).toBe('999')
    expect(displayMicros('1')).toBe('0.000001')
    expect(displayMicros('0')).toBe('0')
    expect(displayMicros(String(10n ** 30n + 5n))).toBe('1,000,000,000,000,000,000,000,000.000005')
  })

  it('formatMicros stays plain digits: it fills the amount field, which is read back', () => {
    expect(formatMicros('999995000000')).toBe('999995')
    expect(formatMicros('1234567890000')).toBe('1234567.89')
  })
})
