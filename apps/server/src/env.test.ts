import { describe, expect, it } from 'vitest'
import { REPO_ROOT, withRepoRelativeDb } from './env.js'

describe('withRepoRelativeDb', () => {
  it('anchors a relative (or default) DB path at the repo root, so the server and dev scripts share one file', () => {
    expect(withRepoRelativeDb({}, '/repo').PAYRUN_DB_PATH).toBe('/repo/payrun.db')
    expect(withRepoRelativeDb({ PAYRUN_DB_PATH: './data/x.db' }, '/repo').PAYRUN_DB_PATH).toBe('/repo/data/x.db')
    expect(withRepoRelativeDb({ PAYRUN_DB_PATH: '/var/payrun.db' }, '/repo').PAYRUN_DB_PATH).toBe('/var/payrun.db')
  })

  it('REPO_ROOT is the workspace root', () => {
    expect(REPO_ROOT).toMatch(/payrun$/)
  })
})
