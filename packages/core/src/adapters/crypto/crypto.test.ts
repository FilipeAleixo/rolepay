import { describe, expect, it } from 'vitest'
import { FundingSourceIdSchema } from '../../domain/funding.js'
import { isMemoSafeRunId } from '../../domain/memo.js'
import { AesGcmKeyVault, RandomIds, SystemClock } from './index.js'

const MASTER = 'a'.repeat(64)
const OTHER_MASTER = 'b'.repeat(64)

describe('AesGcmKeyVault', () => {
  const vault = new AesGcmKeyVault(MASTER)

  it('round-trips a secret under the same context, and never stores it in the clear', async () => {
    const sealed = await vault.seal('0xsecret-key', 'bot-key:g1:0xabc')
    expect(sealed).toMatch(/^v1\./)
    expect(sealed).not.toContain('secret')
    expect(await vault.open(sealed, 'bot-key:g1:0xabc')).toEqual({ ok: true, value: '0xsecret-key' })
  })

  it('uses a fresh nonce per seal', async () => {
    expect(await vault.seal('x', 'c')).not.toBe(await vault.seal('x', 'c'))
  })

  it('refuses to open under another context (a ciphertext copied to another community)', async () => {
    const sealed = await vault.seal('0xsecret-key', 'bot-key:g1:0xabc')
    expect(await vault.open(sealed, 'bot-key:g2:0xabc')).toEqual({ ok: false, error: { code: 'unseal_failed' } })
  })

  it('refuses tampered ciphertext, another master key, and garbage', async () => {
    const sealed = await vault.seal('0xsecret-key', 'c')
    const parts = sealed.split('.')
    const ct = Buffer.from(parts[2] as string, 'base64url')
    ct[0] = (ct[0] as number) ^ 1
    const tampered = [parts[0], parts[1], ct.toString('base64url'), parts[3]].join('.')
    expect((await vault.open(tampered, 'c')).ok).toBe(false)
    expect((await new AesGcmKeyVault(OTHER_MASTER).open(sealed, 'c')).ok).toBe(false)
    expect((await vault.open('not-sealed', 'c')).ok).toBe(false)
  })

  it('fingerprints deterministically, keyed by the master key', async () => {
    expect(await vault.fingerprint('tok')).toBe(await vault.fingerprint('tok'))
    expect(await vault.fingerprint('tok')).not.toBe(await vault.fingerprint('tok2'))
    expect(await vault.fingerprint('tok')).not.toBe(await new AesGcmKeyVault(OTHER_MASTER).fingerprint('tok'))
    expect(await vault.fingerprint('tok')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('still opens secrets sealed before the rename (the key derivation labels never change)', async () => {
    const old = new AesGcmKeyVault('11'.repeat(32))
    const sealed = 'v1.SvmzrTo_J4vHYPD3.QSGoCoHm5yffCOB4hcMXjwKKIiFRLr_I.oXIRale-JExwRKw1Nkd1iw'
    expect(await old.open(sealed, 'guild:1:key:1')).toEqual({ ok: true, value: 'sealed-before-the-rename' })
    expect(await old.fingerprint('tok')).toBe('027987e570a554b85038440d7b058f8fd328b6acdfc92e18dd6e95ede8174e71')
  })

  it('rejects a master key that is not 32 bytes of hex', () => {
    expect(() => new AesGcmKeyVault('abc')).toThrow()
    expect(() => new AesGcmKeyVault('z'.repeat(64))).toThrow()
  })
})

describe('RandomIds', () => {
  const ids = new RandomIds()

  it('makes memo-safe, distinct run IDs', () => {
    const a = ids.runId()
    expect(isMemoSafeRunId(a)).toBe(true)
    expect(a).toMatch(/^run_[0-9a-z]{16}$/)
    expect(ids.runId()).not.toBe(a)
  })

  it('makes distinct policy and policy run IDs that fit a button ID', () => {
    expect(ids.policyId()).toMatch(/^pol_[0-9a-z]{16}$/)
    expect(ids.policyRunId()).toMatch(/^prun_[0-9a-z]{16}$/)
    expect(ids.policyId()).not.toBe(ids.policyId())
  })

  it('makes distinct funding source IDs that the domain accepts', () => {
    const a = ids.fundingSourceId()
    expect(a).toMatch(/^fsrc_[0-9a-z]{16}$/)
    expect(FundingSourceIdSchema.safeParse(a).success).toBe(true)
    expect(ids.fundingSourceId()).not.toBe(a)
  })

  it('makes URL-safe link tokens with 256 bits of entropy', () => {
    const t = ids.linkToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(ids.linkToken()).not.toBe(t)
  })
})

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now()
    const now = new SystemClock().now().getTime()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})
