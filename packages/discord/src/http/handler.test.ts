import { describe, expect, it } from 'vitest'
import { createTestSigner } from '../testing/signer.js'
import { type Dispatch, createInteractionsHandler } from './handler.js'
import { createSignatureVerifier } from './verify.js'

const URL = 'https://payrun.test/discord/interactions'

async function setup(dispatch: Dispatch) {
  const signer = await createTestSigner()
  const background: Promise<unknown>[] = []
  const handler = createInteractionsHandler({
    verify: createSignatureVerifier(signer.publicKeyHex),
    dispatch,
    waitUntil: (p) => background.push(p),
  })
  const post = async (payload: unknown, opts: { sign?: boolean; raw?: string } = {}) => {
    const body = opts.raw ?? JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-signature-timestamp': timestamp }
    if (opts.sign !== false) headers['x-signature-ed25519'] = await signer.sign(timestamp + body)
    return handler(new Request(URL, { method: 'POST', headers, body }))
  }
  return { post, background }
}

describe('createInteractionsHandler', () => {
  it('refuses an unsigned request with 401 and never dispatches it', async () => {
    let called = false
    const { post } = await setup(async () => {
      called = true
      return { kind: 'respond', body: { type: 1 } }
    })
    const res = await post({ type: 1 }, { sign: false })
    expect(res.status).toBe(401)
    expect(called).toBe(false)
  })

  it('answers a signed request with the dispatched JSON body', async () => {
    const { post } = await setup(async (interaction) => ({ kind: 'respond', body: { type: 1, echo: (interaction as { type: number }).type } }))
    const res = await post({ type: 1 })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ type: 1, echo: 1 })
  })

  it('returns 400 for a body that is not JSON or an interaction the dispatcher cannot read', async () => {
    const { post } = await setup(async () => ({ kind: 'invalid', reason: 'unknown shape' }))
    expect((await post(null, { raw: '{not json' })).status).toBe(400)
    expect((await post({ type: 99 })).status).toBe(400)
  })

  it('sends files as multipart/form-data with payload_json and files[n]', async () => {
    const { post } = await setup(async () => ({
      kind: 'respond',
      body: { type: 4, data: { content: 'here' } },
      files: [{ name: 'payrun-run_1.csv', contentType: 'text/csv', data: 'a,b\n1,2\n' }],
    }))
    const res = await post({ type: 2 })
    expect(res.headers.get('content-type')).toMatch(/multipart\/form-data/)
    const form = await res.formData()
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      type: 4,
      data: { content: 'here', attachments: [{ id: 0, filename: 'payrun-run_1.csv' }] },
    })
    const file = form.get('files[0]') as File
    expect(file.name).toBe('payrun-run_1.csv')
    expect(await file.text()).toBe('a,b\n1,2\n')
  })

  it('hands background work to waitUntil after building the response', async () => {
    const order: string[] = []
    const { post, background } = await setup(async () => ({
      kind: 'respond',
      body: { type: 5 },
      background: async () => {
        order.push('background')
      },
    }))
    const res = await post({ type: 2 })
    order.push('responded')
    expect(await res.json()).toEqual({ type: 5 })
    await Promise.all(background)
    expect(order).toEqual(['responded', 'background'])
  })

  it('answers 500 (and reports) when the dispatcher throws, without leaking the error', async () => {
    const reported: unknown[] = []
    const signer = await createTestSigner()
    const handler = createInteractionsHandler({
      verify: createSignatureVerifier(signer.publicKeyHex),
      dispatch: async () => {
        throw new Error('database is down: secret detail')
      },
      onError: (e) => reported.push(e),
    })
    const body = JSON.stringify({ type: 2 })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const res = await handler(
      new Request(URL, { method: 'POST', headers: { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': await signer.sign(timestamp + body) }, body }),
    )
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret')
    expect(reported).toHaveLength(1)
  })
})
