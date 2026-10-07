import { custom, encodeAbiParameters, encodeEventTopics, pad, parseAbiItem, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { ADDRESS_REGISTRY, TESTNET_TOKENS } from '../../constants/tempo.js'
import { depositAddress, userTagFor } from '../../domain/funding.js'
import { TempoFundingChain } from './tempoFundingChain.js'

// ox's published example (VirtualMaster docs): this address and salt pass the 32-bit proof of work.
const MASTER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const SALT = '0x00000000000000000000000000000000000000000000000000000000abf52baf'
const MASTER_ID = '0x58e21090'
const TOKEN = TESTNET_TOKENS.alpha_usd
const SPONSOR = '0x5555555555555555555555555555555555555555'
const DEPOSIT = depositAddress(MASTER_ID, userTagFor(1))
const TX = `0x${'ab'.repeat(32)}` as const
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)')
const REGISTERED = parseAbiItem('event MasterRegistered(bytes4 indexed masterId, address indexed masterAddress)')

/** A Moderato RPC double, scripted per method; records every call's params. */
function rpc(handlers: Record<string, (params: unknown[]) => unknown>, opts: { maxLogRange?: bigint } = {}) {
  const calls: { method: string; params: unknown[] }[] = []
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params: (params ?? []) as unknown[] })
      if (method === 'eth_chainId') return '0xa5bf'
      const h = handlers[method]
      if (!h) throw new Error(`unexpected ${method}`)
      return h((params ?? []) as unknown[])
    },
  })
  return { chain: new TempoFundingChain({ network: 'moderato', rpcUrl: 'http://unused', transport, ...opts }), calls }
}

const transferLog = (from: string, to: string, amount: bigint, logIndex: number, extra: Record<string, unknown> = {}) => ({
  address: TOKEN,
  topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  blockHash: `0x${'cd'.repeat(32)}`,
  blockNumber: '0x64',
  blockTimestamp: '0x6ac6b8b5',
  transactionHash: TX,
  transactionIndex: '0x0',
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
  ...extra,
})

describe('TempoFundingChain', () => {
  it('computes the registration as the registry does: masterId, proof of work, and registerVirtualMaster(salt) on the registry', () => {
    const { chain } = rpc({})
    const r = chain.registration({ master: MASTER, salt: SALT })
    expect(r).toEqual({ masterId: MASTER_ID, proofOfWork: true, call: { to: ADDRESS_REGISTRY, data: `${toFunctionSelector('registerVirtualMaster(bytes32)')}${SALT.slice(2)}` } })
    expect(chain.registration({ master: MASTER, salt: `0x${'00'.repeat(31)}01` })?.proofOfWork).toBe(false)
    expect(chain.registration({ master: '0x0000000000000000000000000000000000000000', salt: SALT })).toBeNull()
    expect(chain.registration({ master: TOKEN, salt: SALT })).toBeNull()
    expect(chain.registration({ master: DEPOSIT, salt: SALT })).toBeNull()
  })

  it('reads who a masterId belongs to from the registry, null when unregistered', async () => {
    const answer = { value: pad(MASTER as `0x${string}`) }
    const { chain, calls } = rpc({ eth_call: () => answer.value })
    expect(await chain.masterOf(MASTER_ID)).toBe(MASTER)
    expect(calls.at(-1)?.params[0]).toMatchObject({ to: ADDRESS_REGISTRY })
    answer.value = pad('0x00')
    expect(await chain.masterOf(MASTER_ID)).toBeNull()
  })

  it("finds a registration's MasterRegistered event and block; null for a missing, reverted or other transaction", async () => {
    const receipt = (status: string, logs: unknown[]) => ({
      transactionHash: TX,
      status,
      blockNumber: '0x3e9',
      blockHash: `0x${'cd'.repeat(32)}`,
      logs,
      transactionIndex: '0x0',
      from: MASTER,
      to: ADDRESS_REGISTRY,
      cumulativeGasUsed: '0x1',
      gasUsed: '0x1',
      effectiveGasPrice: '0x1',
      logsBloom: `0x${'00'.repeat(256)}`,
      type: '0x76',
      contractAddress: null,
    })
    const event = {
      address: ADDRESS_REGISTRY,
      topics: encodeEventTopics({ abi: [REGISTERED], eventName: 'MasterRegistered', args: { masterId: MASTER_ID, masterAddress: MASTER } }),
      data: '0x',
      blockHash: `0x${'cd'.repeat(32)}`,
      blockNumber: '0x3e9',
      transactionHash: TX,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    }
    const answer: { value: unknown } = { value: receipt('0x1', [event]) }
    const { chain } = rpc({ eth_getTransactionReceipt: () => answer.value })
    expect(await chain.findRegistration(TX)).toEqual({ masterId: MASTER_ID, master: MASTER, blockNumber: 1001n })
    answer.value = receipt('0x0', [event])
    expect(await chain.findRegistration(TX)).toBeNull()
    answer.value = receipt('0x1', [{ ...event, address: TOKEN }])
    expect(await chain.findRegistration(TX)).toBeNull()
    answer.value = null
    expect(await chain.findRegistration(TX)).toBeNull()
  })

  it('reads both hops of forwarded deposits, in the given tokens and range, with each block time', async () => {
    const first = transferLog(SPONSOR, DEPOSIT, 5_000_000n, 3)
    const second = transferLog(DEPOSIT, MASTER, 5_000_000n, 4, { blockTimestamp: undefined })
    const { chain, calls } = rpc({
      eth_getLogs: (p) => ((p[0] as { topics: unknown[] }).topics[1] === null ? [first] : [second]),
      eth_getBlockByNumber: () => ({ number: '0x64', timestamp: '0x6ac6b8b5', hash: `0x${'cd'.repeat(32)}`, transactions: [] }),
    })
    const logs = await chain.forwardedTransfers({ tokens: [TOKEN], addresses: [DEPOSIT], master: MASTER, fromBlock: 90n, toBlock: 100n })
    const blockTime = new Date(0x6ac6b8b5 * 1000)
    expect(logs).toEqual([
      { token: TOKEN, from: SPONSOR, to: DEPOSIT, amount: 5_000_000n, txHash: TX, logIndex: 3, blockNumber: 100n, blockTime },
      { token: TOKEN, from: DEPOSIT, to: MASTER, amount: 5_000_000n, txHash: TX, logIndex: 4, blockNumber: 100n, blockTime },
    ])
    const filters = calls.filter((c) => c.method === 'eth_getLogs').map((c) => c.params[0] as { address: string[]; topics: unknown[]; fromBlock: string; toBlock: string })
    expect(filters.map((f) => [f.address, f.fromBlock, f.toBlock])).toEqual([
      [[TOKEN], '0x5a', '0x64'],
      [[TOKEN], '0x5a', '0x64'],
    ])
    // First hops: to any deposit address. Second hops: from a deposit address to the master.
    expect(filters[0]?.topics.slice(1)).toEqual([null, [pad(DEPOSIT)]])
    expect(filters[1]?.topics.slice(1)).toEqual([[pad(DEPOSIT)], pad(MASTER as `0x${string}`)])
  })

  it('splits a long range into chunks the RPC accepts', async () => {
    const { chain, calls } = rpc({ eth_getLogs: () => [] }, { maxLogRange: 10n })
    await chain.forwardedTransfers({ tokens: [TOKEN], addresses: [DEPOSIT], master: MASTER, fromBlock: 1n, toBlock: 25n })
    expect(calls.filter((c) => c.method === 'eth_getLogs').map((c) => [(c.params[0] as { fromBlock: string }).fromBlock, (c.params[0] as { toBlock: string }).toBlock])).toEqual([
      ['0x1', '0xa'],
      ['0x1', '0xa'],
      ['0xb', '0x14'],
      ['0xb', '0x14'],
      ['0x15', '0x19'],
      ['0x15', '0x19'],
    ])
  })

  it('reads the head', async () => {
    const { chain } = rpc({ eth_getBlockByNumber: () => ({ number: '0x3e8', timestamp: '0x10', hash: `0x${'cd'.repeat(32)}`, transactions: [] }) })
    expect(await chain.head()).toEqual({ number: 1000n, timestamp: 16 })
  })
})
