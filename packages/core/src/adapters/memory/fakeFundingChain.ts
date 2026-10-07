import { ADDRESS_REGISTRY } from '../../constants/tempo.js'
import { parseVirtualAddress, type TransferLog } from '../../domain/funding.js'
import type { Hex } from '../../domain/hex.js'
import type { Address } from '../../domain/ids.js'
import type { FundingChain, RegistrationCall } from '../../ports/fundingChain.js'

const lc = <T extends string>(s: T) => s.toLowerCase() as T
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * An in-memory TIP-1022 registry and TIP-20 transfer log, for unit tests. It behaves like the
 * protocol where Rolepay depends on it: a registered masterId maps to one address for good, a
 * transfer to a virtual address of a registered master emits the two-hop Transfer pair (with a
 * TransferWithMemo between them when a memo is given) and credits the master, and one to an
 * unregistered master reverts. Mining real salts is out of reach in a unit test, so the proof of
 * work is simulated: the masterId is the salt's last 4 bytes, and a salt whose first byte is 0xff
 * fails the proof of work.
 */
export class FakeFundingChain implements FundingChain {
  private block = 1000n
  private time = Date.parse('2026-10-06T12:00:00.000Z') / 1000
  private registry = new Map<string, Address>()
  private registrations = new Map<string, { masterId: Hex; master: Address; blockNumber: bigint }>()
  private logs: TransferLog[] = []
  private txCount = 0
  /** What the treasury (or anyone) was credited, per token: balances only go up through deposits here. */
  readonly balances = new Map<string, bigint>()
  /** RPC-shaped calls made, by method (pure computations are not counted). */
  readonly calls = { head: 0, masterOf: 0, findRegistration: 0, forwardedTransfers: 0 }
  /** Set to make the next reads throw, as an RPC outage would. */
  failReads = false

  private read(method: keyof FakeFundingChain['calls']) {
    this.calls[method]++
    if (this.failReads) throw new Error('fetch failed (fake RPC outage)')
  }

  private nextTx(): Hex {
    this.txCount++
    return `0x${this.txCount.toString(16).padStart(64, '0')}` as Hex
  }

  /** A new block, `seconds` after the last one. */
  mine(seconds = 1) {
    this.block++
    this.time += seconds
    return this.block
  }

  async head() {
    this.read('head')
    return { number: this.block, timestamp: this.time }
  }

  registration(input: { master: Address; salt: Hex }) {
    const master = lc(input.master)
    if (master === ZERO || master.startsWith('0x20c000000000000000000000') || parseVirtualAddress(master)) return null
    const salt = lc(input.salt).replace(/^0x/, '').padStart(64, '0')
    const call: RegistrationCall = { to: ADDRESS_REGISTRY, data: `0x5c559d20${salt}` as Hex }
    return { masterId: `0x${salt.slice(-8)}` as Hex, proofOfWork: !salt.startsWith('ff'), call }
  }

  /** The treasury's passkey sending `registerVirtualMaster(salt)`, as the setup page does. */
  register(master: Address, salt: Hex): { txHash: Hex; masterId: Hex } {
    const r = this.registration({ master, salt })
    if (!r || !r.proofOfWork) throw new Error('reverted: ProofOfWorkFailed or InvalidMasterAddress')
    if (this.registry.has(r.masterId)) throw new Error('reverted: MasterIdCollision')
    const blockNumber = this.mine()
    this.registry.set(r.masterId, lc(master))
    const txHash = this.nextTx()
    this.registrations.set(txHash, { masterId: r.masterId, master: lc(master), blockNumber })
    return { txHash, masterId: r.masterId }
  }

  async masterOf(masterId: Hex) {
    this.read('masterOf')
    return this.registry.get(lc(masterId)) ?? null
  }

  async findRegistration(txHash: Hex) {
    this.read('findRegistration')
    return this.registrations.get(lc(txHash)) ?? null
  }

  /**
   * A TIP-20 transfer landing in a new block: to a plain address, one Transfer; to a virtual
   * address of a registered master, the two-hop pair, and the master is credited. To an
   * unregistered master it reverts (`VirtualAddressUnregistered`) and nothing is logged.
   */
  transfer(input: { token: Address; from: Address; to: Address; amount: bigint; memo?: boolean }): { txHash: Hex; blockNumber: bigint } {
    const virtual = parseVirtualAddress(input.to)
    const master = virtual ? this.registry.get(virtual.masterId) : null
    if (virtual && !master) throw new Error('reverted: VirtualAddressUnregistered')
    const blockNumber = this.mine()
    const txHash = this.nextTx()
    const base = { token: lc(input.token), amount: input.amount, txHash, blockNumber, blockTime: new Date(this.time * 1000) }
    const to = lc(input.to)
    let logIndex = 0
    this.logs.push({ ...base, from: lc(input.from), to, logIndex: logIndex++ })
    if (input.memo) logIndex++ // the TransferWithMemo event sits between the hops
    if (master) this.logs.push({ ...base, from: to, to: master, logIndex: logIndex++ })
    const credited = master ?? to
    this.balances.set(`${base.token}:${credited}`, (this.balances.get(`${base.token}:${credited}`) ?? 0n) + input.amount)
    return { txHash, blockNumber }
  }

  balanceOf(token: Address, account: Address) {
    return this.balances.get(`${lc(token)}:${lc(account)}`) ?? 0n
  }

  async forwardedTransfers(input: { tokens: readonly Address[]; addresses: readonly Address[]; master: Address; fromBlock: bigint; toBlock: bigint }) {
    this.read('forwardedTransfers')
    const tokens = new Set<string>(input.tokens.map(lc))
    const addresses = new Set<string>(input.addresses.map(lc))
    const master = lc(input.master)
    return this.logs
      .filter((l) => l.blockNumber >= input.fromBlock && l.blockNumber <= input.toBlock && tokens.has(l.token))
      .filter((l) => addresses.has(l.to) || (addresses.has(l.from) && l.to === master))
      .map((l) => ({ ...l }))
  }
}
