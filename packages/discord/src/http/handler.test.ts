import { describe, expect, it } from 'vitest'
import { MemoryInteractionLog } from '../testing/index.js'
import { createTestSigner } from '../testing/signer.js'
import { type BackgroundTiming, type Dispatch, type InteractionTiming, createInteractionsHandler } from './handler.js'
import { createSignatureVerifier } from './verify.js'

const URL = 'https://rolepay.test/discord/interactions'

/** The time Discord's snowflake ID 900000000000000010 carries: (id >> 22) + Discord's epoch. */
const CREATED_AT_MS = Number(900000000000000010n >> 22n) + 1_420_070_400_000

async function setup(dispatch: Dispatch, opts: { now?: () => number; wallClock?: () => number } = {}) {
  const signer = await createTestSigner()
  const background: Promise<unknown>[] = []
  const timings: InteractionTiming[] = []
  const deferred: BackgroundTiming[] = []
  const handler = createInteractionsHandler({
    verify: createSignatureVerifier(signer.publicKeyHex),
    dispatch,
    waitUntil: (p) => background.push(p),
    seen: new MemoryInteractionLog(),
    onResponse: (t) => timings.push(t),
    onBackground: (t) => deferred.push(t),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.wallClock ? { wallClock: opts.wallClock } : {}),
  })
  const post = async (payload: unknown, opts: { sign?: boolean; raw?: string; timestamp?: string } = {}) => {
    const body = opts.raw ?? JSON.stringify(payload)
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-signature-timestamp': timestamp }
    if (opts.sign !== false) headers['x-signature-ed25519'] = await signer.sign(timestamp + body)
    return handler(new Request(URL, { method: 'POST', headers, body }))
  }
  return { post, background, timings, deferred }
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

  it('a replayed signed request (same interaction ID, inside the 5-minute window) is refused and never dispatched again (L1)', async () => {
    let calls = 0
    const { post } = await setup(async () => (calls++, { kind: 'respond', body: { type: 4, data: { content: 'https://rolepay.test/claim/secret' } } }))
    const interaction = { id: '900000000000000001', type: 2 }
    const timestamp = String(Math.floor(Date.now() / 1000))
    expect((await post(interaction, { timestamp })).status).toBe(200)
    const replay = await post(interaction, { timestamp })
    expect(replay.status).toBe(409)
    expect(await replay.text()).not.toContain('claim')
    expect(calls).toBe(1)
    expect((await post({ id: '900000000000000002', type: 2 })).status).toBe(200)
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
      files: [{ name: 'rolepay-run_1.csv', contentType: 'text/csv', data: 'a,b\n1,2\n' }],
    }))
    const res = await post({ type: 2 })
    expect(res.headers.get('content-type')).toMatch(/multipart\/form-data/)
    const form = await res.formData()
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      type: 4,
      data: { content: 'here', attachments: [{ id: 0, filename: 'rolepay-run_1.csv' }] },
    })
    const file = form.get('files[0]') as File
    expect(file.name).toBe('rolepay-run_1.csv')
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

  it('logs one line per request: kind, name, milliseconds until the response, its type and whether it went well', async () => {
    let clock = 1000
    const { post, timings } = await setup(
      async () => {
        clock += 42 // the handler's work
        return { kind: 'respond', body: { type: 7, data: { content: 'Approved, paying: secret text' } }, label: { kind: 'component', name: 'rolepay:approve' } }
      },
      { now: () => clock, wallClock: () => CREATED_AT_MS + 1700 },
    )
    await post({ id: '900000000000000010', type: 3 })
    expect(timings).toEqual([{ kind: 'component', name: 'rolepay:approve', ms: 42, sinceCreatedMs: 1700, status: 200, responseType: 7, ok: true, late: false }])
    expect(JSON.stringify(timings)).not.toContain('secret')
    expect(JSON.stringify(timings)).not.toContain('900000000000000010')
  })

  it('says how long after Discord created the interaction it reached us (from the ID), null without an ID', async () => {
    const { post, timings } = await setup(async () => ({ kind: 'respond', body: { type: 1 } }), { wallClock: () => CREATED_AT_MS + 250 })
    await post({ id: '900000000000000010', type: 1 })
    await post({ type: 1 })
    expect(timings.map((t) => t.sinceCreatedMs)).toEqual([250, null])
  })

  it('logs work done after the answer once it ends: how long, its phases, never its content', async () => {
    let clock = 1000
    const { post, background, deferred } = await setup(
      async () => ({
        kind: 'respond',
        body: { type: 5, data: {} },
        label: { kind: 'command', name: 'rolepay new' },
        background: async () => {
          clock += 350
          return { phases: { db: 4, reply: 340 } }
        },
      }),
      { now: () => clock },
    )
    await post({ type: 2 })
    expect(deferred).toEqual([])
    await Promise.all(background)
    expect(deferred).toEqual([{ kind: 'command', name: 'rolepay new', ms: 350, ok: true, phases: { db: 4, reply: 340 } }])
  })

  it('logs deferred work that throws as not ok', async () => {
    const { post, background, deferred } = await setup(async () => ({
      kind: 'respond',
      body: { type: 6 },
      label: { kind: 'component', name: 'rolepay:cancel' },
      background: async () => {
        throw new Error('discord is down')
      },
    }))
    await post({ type: 3 })
    await Promise.all(background)
    expect(deferred).toMatchObject([{ name: 'rolepay:cancel', ok: false, phases: {} }])
  })

  it('logs a late acknowledgement and a failed handler as such', async () => {
    const late = await setup(async () => ({ kind: 'respond', body: { type: 6 }, label: { kind: 'component', name: 'rolepay:cancel' }, late: true }))
    await late.post({ type: 3 })
    expect(late.timings[0]).toMatchObject({ name: 'rolepay:cancel', responseType: 6, ok: true, late: true })
    const failed = await setup(async () => ({ kind: 'respond', body: { type: 4 }, label: { kind: 'command', name: 'payee link' }, failed: true }))
    await failed.post({ type: 2 })
    expect(failed.timings[0]).toMatchObject({ name: 'payee link', responseType: 4, ok: false })
  })

  it('logs refused requests too: a bad signature, a shape it cannot read', async () => {
    const { post, timings } = await setup(async () => ({ kind: 'invalid', reason: 'unknown shape' }))
    await post({ type: 1 }, { sign: false })
    await post({ type: 99 })
    expect(timings.map((t) => [t.kind, t.status, t.responseType, t.ok])).toEqual([
      ['unverified', 401, null, false],
      ['invalid', 400, null, false],
    ])
  })
})
