import { describe, expect, it } from 'vitest'
import type { ExecutionJob } from '../ports.js'
import { InProcessExecutionQueue } from './inProcessQueue.js'

const job = (runId: string): ExecutionJob => ({
  kind: 'execute_run',
  guildId: '1094309218049937418',
  runId,
  reply: { applicationId: '500000000000000001', token: `tok-${runId}` },
  channelId: null,
})

function gate() {
  let open!: () => void
  const opened = new Promise<void>((r) => {
    open = r
  })
  return { open, opened }
}

describe('InProcessExecutionQueue', () => {
  it('enqueue returns at once; the job runs in the background; idle() waits for it', async () => {
    const g = gate()
    const done: string[] = []
    const queue = new InProcessExecutionQueue(async (j) => {
      await g.opened
      done.push(j.runId)
    })
    await queue.enqueue(job('run_1'))
    expect(done).toEqual([])
    g.open()
    await queue.idle()
    expect(done).toEqual(['run_1'])
  })

  it('runs jobs for the same run one at a time, in order', async () => {
    const log: string[] = []
    let running = 0
    const queue = new InProcessExecutionQueue(async (j) => {
      running++
      expect(running).toBe(1)
      log.push(`start ${j.reply.token}`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`end ${j.reply.token}`)
      running--
    })
    await queue.enqueue({ ...job('run_1'), reply: { applicationId: '500000000000000001', token: 'a' } })
    await queue.enqueue({ ...job('run_1'), reply: { applicationId: '500000000000000001', token: 'b' } })
    await queue.idle()
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('runs jobs for different runs concurrently', async () => {
    const g = gate()
    const started: string[] = []
    const queue = new InProcessExecutionQueue(async (j) => {
      started.push(j.runId)
      await g.opened
    })
    await queue.enqueue(job('run_1'))
    await queue.enqueue(job('run_2'))
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual(['run_1', 'run_2'])
    g.open()
    await queue.idle()
  })

  it('a job that throws is reported and does not block the next job for that run', async () => {
    const errors: unknown[] = []
    const ran: string[] = []
    let first = true
    const queue = new InProcessExecutionQueue(
      async (j) => {
        if (first) {
          first = false
          throw new Error('boom')
        }
        ran.push(j.runId)
      },
      { onError: (e) => errors.push(e) },
    )
    await queue.enqueue(job('run_1'))
    await queue.enqueue(job('run_1'))
    await queue.idle()
    expect(errors).toHaveLength(1)
    expect(ran).toEqual(['run_1'])
    expect(queue.size).toBe(0)
  })
})
