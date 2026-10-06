import { describe, expect, it } from 'vitest'
import { FakeDiscordRest } from '../testing/fakeDiscordRest.js'
import { type Outcome, renderOutcome } from './outcome.js'

const ctx = { applicationId: '500000000000000001', token: 'tok', guildId: '1094309218049937418', channelId: null, caller: { userId: '200000000000000001', roles: [], permissions: 0n } }

async function render(outcome: Outcome) {
  const rest = new FakeDiscordRest()
  const d = renderOutcome(outcome, ctx, rest)
  if (d.kind !== 'respond') throw new Error('expected a response')
  await d.background?.()
  return { d, rest }
}

describe('renderOutcome', () => {
  it('a reply is a channel message, ephemeral when asked, files kept aside for multipart', async () => {
    const { d } = await render({ kind: 'reply', ephemeral: true, message: { content: 'hi', files: [{ name: 'a.csv', contentType: 'text/csv', data: 'x' }] } })
    expect(d.body).toEqual({ type: 4, data: { content: 'hi', flags: 64 } })
    expect(d.files).toEqual([{ name: 'a.csv', contentType: 'text/csv', data: 'x' }])
  })

  it('an update edits the message the button is on', async () => {
    const { d } = await render({ kind: 'update', message: { content: 'paying' } })
    expect(d.body).toEqual({ type: 7, data: { content: 'paying' } })
  })

  it('a deferral answers at once and edits the reply when the work is done', async () => {
    const { d, rest } = await render({ kind: 'defer', ephemeral: true, work: async () => ({ ok: true, message: { content: 'done' } }) })
    expect(d.body).toEqual({ type: 5, data: { flags: 64 } })
    expect(rest.lastEdit('tok')).toEqual({ content: 'done' })
  })

  it('a public deferral that fails removes the placeholder and tells only the caller', async () => {
    const { d, rest } = await render({ kind: 'defer', ephemeral: false, work: async () => ({ ok: false, message: { content: 'nobody to pay' } }) })
    expect(d.body).toEqual({ type: 5, data: {} })
    expect(rest.deletes).toHaveLength(1)
    expect(rest.followUps[0]?.message).toEqual({ content: 'nobody to pay', flags: 64 })
  })

  it('an ephemeral deferral that fails shows the error in place', async () => {
    const { rest } = await render({ kind: 'defer', ephemeral: true, work: async () => ({ ok: false, message: { content: 'not set up' } }) })
    expect(rest.lastEdit('tok')).toEqual({ content: 'not set up' })
  })

  it('deferred work that throws still ends with a message, never a spinner forever', async () => {
    const { rest } = await render({
      kind: 'defer',
      ephemeral: true,
      work: async () => {
        throw new Error('rpc down')
      },
    })
    expect(rest.lastEdit('tok')?.content).toMatch(/went wrong/)
  })

  it('autocomplete choices', async () => {
    const { d } = await render({ kind: 'choices', choices: [{ name: 'run_1 · paid', value: 'run_1' }] })
    expect(d.body).toEqual({ type: 8, data: { choices: [{ name: 'run_1 · paid', value: 'run_1' }] } })
  })
})
