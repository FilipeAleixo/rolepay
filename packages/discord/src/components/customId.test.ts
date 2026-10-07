import { describe, expect, it } from 'vitest'
import { decodeCustomId, encodeCustomId } from './customId.js'

describe('run button custom_id', () => {
  it('is rolepay:<action>:<runId>, and decodes back', () => {
    expect(encodeCustomId('approve', 'run_1')).toBe('rolepay:approve:run_1')
    expect(decodeCustomId(encodeCustomId('retry', 'run_1'))).toEqual({ action: 'retry', runId: 'run_1' })
  })

  it('still decodes the payrun: prefix of buttons posted before the rename', () => {
    expect(decodeCustomId('payrun:approve:run_1')).toEqual({ action: 'approve', runId: 'run_1' })
    expect(decodeCustomId('payrun:cancel:run_2')).toEqual({ action: 'cancel', runId: 'run_2' })
  })

  it('refuses anything else', () => {
    for (const bad of ['other:approve:run_1', 'rolepay:pay:run_1', 'rolepay:approve:', 'proposal:create:prop_1', 'rolepay:approve:run 1']) {
      expect(decodeCustomId(bad)).toBeNull()
    }
  })
})
