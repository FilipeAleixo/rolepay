import { describe, expect, it } from 'vitest'
import { explainPasskeyError } from './dom.js'

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
})
