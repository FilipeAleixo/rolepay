import { describe, expect, it } from 'vitest'
import { GUILD, OTHER_PASSKEY, PASSKEY, registeredCommunity, setupLink, webHarness } from '../../test/harness.js'

type Json = any
const json = async (res: Response): Promise<Json> => res.json()
// The fake registry takes a salt's last 4 bytes as the masterId; a first byte of 0xff fails the proof of work.
const SALT = `0x${'00'.repeat(28)}58e21090`
const BAD_SALT = `0x${'ff'.repeat(32)}`

async function treasuryPage(opts: { funding?: boolean } = {}) {
  const h = webHarness(opts)
  await registeredCommunity(h)
  const token = await setupLink(h)
  return { h, token, base: `/setup/${token}` }
}

describe('deposit addresses on the treasurer setup page', () => {
  it('the state says whether this server offers them, and whether the treasury has them', async () => {
    const { h, base } = await treasuryPage()
    expect((await json(await h.send(`${base}/state`, { passkey: PASSKEY }))).deposits).toEqual({ available: true, masterId: null, txHash: null, sources: 0, dashboard: `/dashboard/${GUILD}/funding` })
    const { txHash, masterId } = h.fundingChain.register(PASSKEY, SALT as `0x${string}`)
    expect((await h.post(`${base}/deposits/confirm`, { masterId, txHash }, PASSKEY)).status).toBe(200)
    expect((await json(await h.send(`${base}/state`, { passkey: PASSKEY }))).deposits).toMatchObject({ available: true, masterId: '0x58e21090', txHash })
    const bare = await treasuryPage({ funding: false })
    expect((await json(await bare.h.send(`${bare.base}/state`, { passkey: PASSKEY }))).deposits).toMatchObject({ available: false })
  })

  it('the page has the step, with the one-prompt promise; without the funding chain it has none', async () => {
    const { h, base } = await treasuryPage()
    const html = await (await h.send(base)).text()
    expect(html).toContain('data-step="deposits"')
    expect(html).toContain('id="deposits"')
    expect(html).toContain('Deposit addresses')
    const bare = await treasuryPage({ funding: false })
    expect(await (await bare.h.send(bare.base)).text()).not.toContain('data-step="deposits"')
  })

  it("plans the registration for the treasury: the masterId and the server's copy of the call, which the page checks against its own", async () => {
    const { h, base } = await treasuryPage()
    const res = await h.post(`${base}/deposits/plan`, { salt: SALT }, PASSKEY)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, masterId: '0x58e21090', master: PASSKEY, call: h.fundingChain.registration({ master: PASSKEY, salt: SALT as `0x${string}` })?.call })
  })

  it('refuses a salt without the proof of work, a taken masterId (the page mines again), and a second setup', async () => {
    const { h, base } = await treasuryPage()
    expect(await json(await h.post(`${base}/deposits/plan`, { salt: BAD_SALT }, PASSKEY))).toEqual({ ok: false, error: { code: 'invalid_salt' } })
    expect((await h.post(`${base}/deposits/plan`, { salt: 'nope' }, PASSKEY)).status).toBe(400)
    expect((await h.post(`${base}/deposits/plan`, {}, PASSKEY)).status).toBe(400)
    h.fundingChain.register(OTHER_PASSKEY, SALT as `0x${string}`)
    const taken = await h.post(`${base}/deposits/plan`, { salt: SALT }, PASSKEY)
    expect([taken.status, (await json(taken)).error.code]).toEqual([409, 'master_id_taken'])
    const mine = h.fundingChain.register(PASSKEY, `0x${'00'.repeat(28)}0a0b0c0d`)
    await h.post(`${base}/deposits/confirm`, mine, PASSKEY)
    const again = await h.post(`${base}/deposits/plan`, { salt: `0x${'00'.repeat(28)}01020304` }, PASSKEY)
    expect([again.status, (await json(again)).error.code]).toEqual([409, 'already_set_up'])
  })

  it('records the registration only from the chain: not before it lands, and never for another address', async () => {
    const { h, base } = await treasuryPage()
    const early = await h.post(`${base}/deposits/confirm`, { masterId: '0x58e21090', txHash: null }, PASSKEY)
    expect([early.status, (await json(early)).error.code]).toEqual([409, 'not_registered'])
    const theirs = h.fundingChain.register(OTHER_PASSKEY, SALT as `0x${string}`)
    expect((await json(await h.post(`${base}/deposits/confirm`, theirs, PASSKEY))).error.code).toBe('not_registered')
    expect((await h.post(`${base}/deposits/confirm`, { masterId: 'not hex' }, PASSKEY)).status).toBe(400)
    const mine = h.fundingChain.register(PASSKEY, `0x${'00'.repeat(28)}0a0b0c0d`)
    const ok = await h.post(`${base}/deposits/confirm`, mine, PASSKEY)
    expect(await json(ok)).toEqual({ ok: true, masterId: '0x0a0b0c0d', txHash: mine.txHash })
  })

  it('only the treasury passkey, proven by a sign-in, can plan or confirm', async () => {
    const { h, base } = await treasuryPage()
    for (const path of ['plan', 'confirm']) {
      expect((await h.post(`${base}/deposits/${path}`, { salt: SALT })).status).toBe(401)
      expect((await h.post(`${base}/deposits/${path}`, { salt: SALT }, OTHER_PASSKEY)).status).toBe(403)
      expect((await json(await h.post(`${base}/deposits/${path}`, { salt: SALT }, { address: PASSKEY, proof: 'registration', issuedAt: 2_000_000_000 }))).error.code).toBe('sign_in_required')
    }
  })

  it('a server without the funding chain answers not_configured', async () => {
    const { h, base } = await treasuryPage({ funding: false })
    const res = await h.post(`${base}/deposits/plan`, { salt: SALT }, PASSKEY)
    expect([res.status, (await json(res)).error.code]).toEqual([409, 'not_configured'])
  })
})
