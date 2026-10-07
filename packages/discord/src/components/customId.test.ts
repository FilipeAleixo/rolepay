import { describe, expect, it } from 'vitest'
import { decodeCustomId, decodePolicyButton, decodeVetoButton, encodeCustomId, encodePolicyButton, encodeVetoButton } from './customId.js'

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

describe('policy buttons', () => {
  it('round-trip, carry the version the approver saw, and fit in 100 characters', () => {
    const id = encodePolicyButton('approve', 'pol_abcdefghijklmnop', 12)
    expect(id).toBe('policy:approve:pol_abcdefghijklmnop:12')
    expect(decodePolicyButton(id)).toEqual({ action: 'approve', policyId: 'pol_abcdefghijklmnop', version: 12 })
    expect(decodePolicyButton('policy:explode:pol_1:1')).toBeNull()
    expect(decodePolicyButton('policy:approve:pol_1')).toBeNull()
    expect(decodeVetoButton(encodeVetoButton('prun_abcdefghijklmnop'))).toEqual({ policyRunId: 'prun_abcdefghijklmnop' })
    expect(decodeVetoButton('policy-run:approve:prun_1')).toBeNull()
    expect(encodeVetoButton('p'.repeat(40)).length).toBeLessThanOrEqual(100)
  })
})
