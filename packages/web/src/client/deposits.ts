// Deposit addresses (Tempo virtual addresses, TIP-1022): the registration the treasury's passkey
// signs. The page mines the salt and builds the call itself; the server's copy is only checked
// against it (`registrationMismatch`), never signed.
import { Actions, VirtualMaster } from 'viem/tempo'
import { encodeFunctionData } from 'viem/utils'

type Hex = `0x${string}`

/** The registration of a master: its masterId and the exact call that registers it. */
export type Registration = { masterId: string; master: string; call: { to: string; data: string } }

/**
 * `registerVirtualMaster(salt)` on Tempo's address registry, sent by the treasury: the masterId it
 * yields and the call, as this page computes them. null when the account can never be a master
 * (ox refuses the zero address, a virtual address and a token, as the registry does).
 */
export function buildRegistration(treasury: string, salt: string): Registration | null {
  try {
    const call = Actions.virtualAddress.registerMaster.call({ salt: salt as Hex })
    const masterId = VirtualMaster.getMasterId({ address: treasury as Hex, salt: salt as Hex })
    return { masterId: masterId.toLowerCase(), master: treasury.toLowerCase(), call: { to: call.address.toLowerCase(), data: encodeFunctionData(call as never).toLowerCase() } }
  } catch {
    return null
  }
}

/** What differs between the registration this page built and the server's copy, in words, or null when they are the same. */
export function registrationMismatch(mine: Registration, theirs: unknown): string | null {
  try {
    const t = theirs as Registration
    if (t.master.toLowerCase() !== mine.master) return 'another account as the master'
    if (t.masterId.toLowerCase() !== mine.masterId) return 'a different masterId'
    if (t.call.to.toLowerCase() !== mine.call.to) return 'a different contract to call'
    if (t.call.data.toLowerCase() !== mine.call.data) return 'a different call'
    return null
  } catch {
    return 'a shape this page cannot read'
  }
}

/** Exactly what the treasurer is about to sign, in plain words. */
export const describeRegistration = (r: Registration) =>
  `register this account as the owner of the deposit addresses that start with ${r.masterId} (one call, registerVirtualMaster, to Tempo's address registry ${r.call.to}). It moves no money.`

/**
 * The salt search stopped making progress (no worker reported for a while). The page says so
 * instead of waiting for ever.
 */
export class MiningStalled extends Error {
  constructor() {
    super('the browser stopped finding a registration code')
    this.name = 'MiningStalled'
  }
}

/**
 * Put in front of the source of ox's mining worker (viem's `VirtualMaster.mineSaltAsync`, ox
 * 0.14.45). That worker sets `self.onmessage` only after `WebAssembly.instantiate` resolves, while
 * the page posts each worker its start message at once: a message that arrives first has no
 * handler and is dropped, so that worker never mines, and when none starts the promise never
 * settles. Seen in Chromium on 2026-10-07: no progress at all, or a fraction of the workers (4
 * million tries a second instead of 42). Node's worker_threads queue messages until a listener is
 * attached, which is why it works there. This queues messages until onmessage is set, then hands
 * them over in order, once.
 */
export const WORKER_QUEUE_SHIM =
  "(function(){var q=[];var h=null;self.addEventListener('message',function(e){if(!h)q.push(e)});" +
  "Object.defineProperty(self,'onmessage',{configurable:true,get:function(){return h},set:function(f){h=f;" +
  "self.addEventListener('message',function(e){f.call(self,e)});var p=q;q=[];p.forEach(function(e){f.call(self,e)})}})})();\n"

/**
 * Runs `work` with `Blob` replaced, so that the JavaScript source of ox's miner (it builds its
 * workers from a Blob URL, once, on its first search) gets the shim in front. Every other Blob is
 * made as usual, and `Blob` is restored when `work` ends, however it ends.
 */
export async function withQueuedWorkerMessages<T>(work: () => Promise<T>): Promise<T> {
  const Original = globalThis.Blob
  globalThis.Blob = class extends Original {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      const isMiner = options?.type === 'application/javascript' && typeof parts?.[0] === 'string' && parts[0].includes('mineLoop')
      super(isMiner ? [WORKER_QUEUE_SHIM, ...(parts ?? [])] : parts, options)
    }
  } as typeof Blob
  try {
    return await work()
  } finally {
    globalThis.Blob = Original
  }
}

type Miner = typeof VirtualMaster.mineSaltAsync

/**
 * How many salts one search may try. ox stops after 2^32 by default, and the chance that none of
 * those passes a 32-bit proof of work is about 1/e (37%); the search starts from the same salt each
 * time, so for such an account every try would fail the same way. 2^40 leaves a chance of about e^-256.
 */
const SEARCH_COUNT = 2 ** 40

/**
 * Mines a salt that passes the registry's 32-bit proof of work for `treasury`, with WebAssembly in
 * Web Workers (all but one of this device's cores): about 4.3 billion tries on average, about a
 * minute and a half on a recent laptop. `start` resumes after an earlier salt whose masterId was
 * taken. Stops with `MiningStalled` when no progress comes for `stallMs` (15 s).
 */
export async function mineSalt(
  treasury: string,
  onProgress: (tries: number) => void,
  start = 0n,
  deps: { mine?: Miner; stallMs?: number } = {},
): Promise<{ salt: string; masterId: string } | null> {
  const mine = deps.mine ?? VirtualMaster.mineSaltAsync
  const stallMs = deps.stallMs ?? 15_000
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const watch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => abort.abort(new MiningStalled()), stallMs)
  }
  watch()
  try {
    const found = await withQueuedWorkerMessages(() =>
      mine({
        address: treasury as Hex,
        start,
        count: SEARCH_COUNT,
        signal: abort.signal,
        onProgress: (p) => {
          watch()
          onProgress(p.attempts)
        },
      }),
    )
    return found ? { salt: found.salt, masterId: found.masterId.toLowerCase() } : null
  } catch (error) {
    if (abort.signal.aborted && abort.signal.reason instanceof MiningStalled) throw abort.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
}
