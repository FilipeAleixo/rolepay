import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, environmentFrom, withRepoRelativeDb } from './env.js'

const none = () => false

describe('withRepoRelativeDb', () => {
  it('anchors a relative DB path at the repo root, so the server and dev scripts share one file', () => {
    expect(withRepoRelativeDb({ ROLEPAY_DB_PATH: './data/x.db' }, '/repo', none).ROLEPAY_DB_PATH).toBe('/repo/data/x.db')
    expect(withRepoRelativeDb({ ROLEPAY_DB_PATH: '/var/rolepay.db' }, '/repo', none).ROLEPAY_DB_PATH).toBe('/var/rolepay.db')
  })

  it('by default a new install gets rolepay.db, and an install from before the rename keeps its payrun.db', () => {
    expect(withRepoRelativeDb({}, '/repo', none).ROLEPAY_DB_PATH).toBe('/repo/rolepay.db')
    expect(withRepoRelativeDb({ ROLEPAY_DB_PATH: '' }, '/repo', none).ROLEPAY_DB_PATH).toBe('/repo/rolepay.db')
    const legacy = (path: string) => path === '/repo/payrun.db'
    expect(withRepoRelativeDb({}, '/repo', legacy).ROLEPAY_DB_PATH).toBe('/repo/payrun.db')
    expect(withRepoRelativeDb({ ROLEPAY_DB_PATH: './rolepay.db' }, '/repo', legacy).ROLEPAY_DB_PATH).toBe('/repo/rolepay.db')
  })

  it('REPO_ROOT is the workspace root (whatever the checkout is called)', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true)
  })
})

describe('environmentFrom (what loadEnvironment returns)', () => {
  it('reads the deprecated PAYRUN_* names as ROLEPAY_*, so an existing .env needs no edits', () => {
    const env = environmentFrom({ PAYRUN_DB_PATH: './data/x.db', PAYRUN_TEST_ROOT_PRIVATE_KEY: 'k', PAYRUN_DEV_SHORTCUTS: 'true' }, '/repo', none)
    expect(env).toMatchObject({ ROLEPAY_DB_PATH: '/repo/data/x.db', ROLEPAY_TEST_ROOT_PRIVATE_KEY: 'k', ROLEPAY_DEV_SHORTCUTS: 'true' })
    expect(environmentFrom({ ROLEPAY_DB_PATH: './new.db', PAYRUN_DB_PATH: './old.db' }, '/repo', none).ROLEPAY_DB_PATH).toBe('/repo/new.db')
  })
})
