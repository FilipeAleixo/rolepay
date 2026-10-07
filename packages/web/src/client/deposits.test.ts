import { toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { MiningStalled, WORKER_QUEUE_SHIM, buildRegistration, describeRegistration, mineSalt, registrationMismatch, withQueuedWorkerMessages } from './deposits.js'

// ox's published example (VirtualMaster docs): this address and salt pass the 32-bit proof of work.
const TREASURY = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const SALT = '0x00000000000000000000000000000000000000000000000000000000abf52baf'
const REGISTRY = '0xfdc0000000000000000000000000000000000000'

describe('the registration the page builds itself', () => {
  it('is registerVirtualMaster(salt) on the address registry, with the masterId the registry will give', () => {
    expect(buildRegistration(TREASURY.toUpperCase().replace('0X', '0x'), SALT)).toEqual({
      masterId: '0x58e21090',
      master: TREASURY,
      call: { to: REGISTRY, data: `${toFunctionSelector('registerVirtualMaster(bytes32)')}${SALT.slice(2)}` },
    })
  })

  it('refuses an account that can never be a master', () => {
    expect(buildRegistration('0x0000000000000000000000000000000000000000', SALT)).toBeNull()
    expect(buildRegistration('0x20c0000000000000000000000000000000000001', SALT)).toBeNull()
  })

  it('says what it signs in plain words', () => {
    const r = buildRegistration(TREASURY, SALT)
    expect(r && describeRegistration(r)).toBe(
      `register this account as the owner of the deposit addresses that start with 0x58e21090 (one call, registerVirtualMaster, to Tempo's address registry ${REGISTRY}). It moves no money.`,
    )
  })
})

describe("registrationMismatch: the server's copy is checked, never signed", () => {
  const mine = buildRegistration(TREASURY, SALT)
  if (!mine) throw new Error('fixture')

  it('accepts the same registration, whatever the case of its hex', () => {
    expect(registrationMismatch(mine, { ...mine, masterId: '0x58E21090', call: { to: REGISTRY.toUpperCase().replace('0X', '0x'), data: mine.call.data.toUpperCase().replace('0X', '0x') } })).toBeNull()
  })

  it('names what differs', () => {
    expect(registrationMismatch(mine, { ...mine, master: '0x7777777777777777777777777777777777777777' })).toBe('another account as the master')
    expect(registrationMismatch(mine, { ...mine, masterId: '0x01020304' })).toBe('a different masterId')
    expect(registrationMismatch(mine, { ...mine, call: { ...mine.call, to: '0xaaaaaaaa00000000000000000000000000000000' } })).toBe('a different contract to call')
    expect(registrationMismatch(mine, { ...mine, call: { ...mine.call, data: `${mine.call.data.slice(0, -2)}00` } })).toBe('a different call')
    expect(registrationMismatch(mine, { masterId: 1 })).toBe('a shape this page cannot read')
    expect(registrationMismatch(mine, null)).toBe('a shape this page cannot read')
  })
})

describe("mining in the browser: ox's workers never lose their start message", () => {
  /** A worker's global scope, enough for the shim: messages dispatched as the browser does. */
  function fakeWorkerScope() {
    const scope = new EventTarget() as EventTarget & { onmessage?: unknown }
    new Function('self', WORKER_QUEUE_SHIM)(scope)
    const send = (data: unknown) => scope.dispatchEvent(new MessageEvent('message', { data }))
    return { scope, send }
  }

  it('queues a message that arrives before onmessage is set, then hands it over, in order, once', () => {
    const { scope, send } = fakeWorkerScope()
    send({ type: 'start', n: 1 }) // before WebAssembly.instantiate resolved: dropped without the shim
    send({ type: 'start', n: 2 })
    const got: unknown[] = []
    scope.onmessage = (e: MessageEvent) => got.push(e.data)
    expect(got).toEqual([
      { type: 'start', n: 1 },
      { type: 'start', n: 2 },
    ])
    send({ type: 'start', n: 3 })
    expect(got).toHaveLength(3)
    expect(scope.onmessage).toBeTypeOf('function')
  })

  it("puts the shim in front of ox's miner source only, and restores Blob afterwards, even on failure", async () => {
    const Original = globalThis.Blob
    const texts = await withQueuedWorkerMessages(async () =>
      Promise.all([
        new Blob(['var x = 1; function mineLoop(data) {}'], { type: 'application/javascript' }).text(),
        new Blob(['just text'], { type: 'text/plain' }).text(),
      ]),
    )
    expect(texts[0]?.startsWith(WORKER_QUEUE_SHIM)).toBe(true)
    expect(texts[0]?.endsWith('function mineLoop(data) {}')).toBe(true)
    expect(texts[1]).toBe('just text')
    expect(globalThis.Blob).toBe(Original)
    await expect(withQueuedWorkerMessages(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(globalThis.Blob).toBe(Original)
  })

  it('stops with MiningStalled when no progress comes for a while, instead of waiting for ever', async () => {
    const never = (o: { signal?: AbortSignal }) =>
      new Promise<undefined>((_, reject) => o.signal?.addEventListener('abort', () => reject(o.signal?.reason ?? new Error('aborted'))))
    await expect(mineSalt(TREASURY, () => {}, 0n, { mine: never as never, stallMs: 20 })).rejects.toBeInstanceOf(MiningStalled)
  })

  it('reports progress and returns the salt the miner found', async () => {
    const seen: number[] = []
    const found = await mineSalt(TREASURY, (n) => seen.push(n), 5n, {
      mine: (async (o: { start: bigint; onProgress: (p: { attempts: number }) => void }) => {
        expect(o.start).toBe(5n)
        o.onProgress({ attempts: 100_000 })
        o.onProgress({ attempts: 200_000 })
        return { salt: SALT, masterId: '0x58E21090', registrationHash: '0x' }
      }) as never,
      stallMs: 1_000,
    })
    expect(found).toEqual({ salt: SALT, masterId: '0x58e21090' })
    expect(seen).toEqual([100_000, 200_000])
  })
})
