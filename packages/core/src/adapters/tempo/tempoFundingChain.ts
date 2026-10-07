import { type Hex, type Transport, encodeFunctionData, parseAbiItem, parseEventLogs } from 'viem'
import { Abis, Actions, Addresses, VirtualMaster, createClient, http } from 'viem/tempo'
import { NETWORKS, type NetworkName } from '../../constants/tempo.js'
import type { TransferLog } from '../../domain/funding.js'
import type { Address } from '../../domain/ids.js'
import type { FundingChain, RegistrationCall } from '../../ports/fundingChain.js'
import { errorSummary } from './encoding.js'
import { retryUnavailable } from './retryUnavailable.js'

export type TempoFundingChainOptions = {
  network: NetworkName
  rpcUrl: string
  /** Max blocks per eth_getLogs call. */
  maxLogRange?: bigint
  /** For tests: the RPC transport (default: http to `rpcUrl`, with retries). */
  transport?: Transport
}

const lc = <T extends string>(s: T) => s.toLowerCase() as T
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)')

/**
 * FundingChain on Tempo through viem's built-in TIP-1022 support (`Actions.virtualAddress`,
 * `VirtualMaster`). Read only: the registration is signed by the treasury's passkey in the
 * browser. Reads throw on infrastructure failure (the watcher keeps its cursor and tries again).
 */
export class TempoFundingChain implements FundingChain {
  private readonly reader: ReturnType<typeof createClient>
  private readonly maxLogRange: bigint

  constructor(opts: TempoFundingChainOptions) {
    // The public RPC sometimes answers with an HTML error page or -32002 under load: retry reads.
    const transport = opts.transport ?? retryUnavailable(http(opts.rpcUrl, { retryCount: 6, retryDelay: 400 }))
    this.reader = createClient({ testnet: NETWORKS[opts.network].testnet, transport })
    this.maxLogRange = opts.maxLogRange ?? 10_000n
  }

  async head() {
    const b = await this.reader.getBlock()
    return { number: b.number as bigint, timestamp: Number(b.timestamp) }
  }

  registration(input: { master: Address; salt: Hex }) {
    try {
      const value = { address: input.master, salt: input.salt }
      const call = Actions.virtualAddress.registerMaster.call({ salt: input.salt })
      const registrationCall: RegistrationCall = { to: lc(call.address) as Address, data: encodeFunctionData(call as never) }
      return { masterId: lc(VirtualMaster.getMasterId(value)), proofOfWork: VirtualMaster.validateSalt(value), call: registrationCall }
    } catch {
      // ox refuses the zero address, a virtual address and a TIP-20 token as masters, as the registry does.
      return null
    }
  }

  async masterOf(masterId: Hex) {
    const master = await Actions.virtualAddress.getMasterAddress(this.reader, { masterId })
    return master ? (lc(master) as Address) : null
  }

  async findRegistration(txHash: Hex) {
    let receipt: Awaited<ReturnType<typeof this.reader.getTransactionReceipt>>
    try {
      receipt = await this.reader.getTransactionReceipt({ hash: txHash })
    } catch (e) {
      if (/could not be found|not found/i.test(errorSummary(e))) return null
      throw e
    }
    if (receipt.status !== 'success') return null
    const registry = lc(Addresses.addressRegistry)
    const [event] = parseEventLogs({ abi: Abis.addressRegistry, logs: receipt.logs.filter((l) => lc(l.address) === registry), eventName: 'MasterRegistered' })
    if (!event) return null
    return { masterId: lc(event.args.masterId), master: lc(event.args.masterAddress) as Address, blockNumber: receipt.blockNumber }
  }

  async forwardedTransfers(input: { tokens: readonly Address[]; addresses: readonly Address[]; master: Address; fromBlock: bigint; toBlock: bigint }): Promise<TransferLog[]> {
    if (input.tokens.length === 0 || input.addresses.length === 0) return []
    const out: TransferLog[] = []
    const times = new Map<bigint, Date>()
    const address = [...input.tokens]
    const addresses = [...input.addresses]
    for (let start = input.fromBlock; start <= input.toBlock; start += this.maxLogRange) {
      const end = start + this.maxLogRange - 1n < input.toBlock ? start + this.maxLogRange - 1n : input.toBlock
      const range = { address, event: TRANSFER, fromBlock: start, toBlock: end } as const
      // First hops (sender to a deposit address) and second hops (a deposit address to the master).
      const [first, second] = await Promise.all([
        this.reader.getLogs({ ...range, args: { to: addresses } }),
        this.reader.getLogs({ ...range, args: { from: addresses, to: input.master } }),
      ])
      for (const log of [...first, ...second]) {
        if (log.removed || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue
        let blockTime = log.blockTimestamp ? new Date(Number(log.blockTimestamp) * 1000) : times.get(log.blockNumber)
        if (!blockTime) {
          blockTime = new Date(Number((await this.reader.getBlock({ blockNumber: log.blockNumber })).timestamp) * 1000)
        }
        times.set(log.blockNumber, blockTime)
        out.push({
          token: lc(log.address),
          from: lc(log.args.from as string),
          to: lc(log.args.to as string),
          amount: log.args.amount as bigint,
          txHash: lc(log.transactionHash),
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockTime,
        })
      }
    }
    return out
  }
}
