import { describe, expect, it } from 'vitest'
import { OptionType, Permission } from '../api.js'
import { ROUTED_COMMANDS } from '../app/router.js'
import { COMMAND_DEFINITIONS } from './definitions.js'

type Def = { name: string; description: string; type?: number; required?: boolean; options?: Def[]; default_member_permissions?: string; contexts?: number[] }
const defs = COMMAND_DEFINITIONS as Def[]

describe('COMMAND_DEFINITIONS (the JSON registered with Discord)', () => {
  const subcommands = defs.flatMap((c) => (c.options ?? []).filter((o) => o.type === OptionType.SubCommand).map((s) => `${c.name} ${s.name}`))

  it('every registered subcommand has a handler, and every handler is registered', () => {
    expect([...subcommands].sort()).toEqual([...ROUTED_COMMANDS].sort())
  })

  it('names and descriptions fit Discord limits; required options come first', () => {
    const walk = (d: Def): void => {
      expect(d.name).toMatch(/^[a-z0-9_-]{1,32}$/)
      expect(d.description.length).toBeGreaterThan(0)
      expect(d.description.length).toBeLessThanOrEqual(100)
      const leaves = (d.options ?? []).filter((o) => o.type !== OptionType.SubCommand)
      const firstOptional = leaves.findIndex((o) => !o.required)
      if (firstOptional >= 0) expect(leaves.slice(firstOptional).some((o) => o.required)).toBe(false)
      for (const o of d.options ?? []) walk(o)
    }
    for (const d of defs) walk(d)
  })

  it('/payrun is shown to Manage Server by default; /payee to everyone; both only inside servers', () => {
    const payrun = defs.find((d) => d.name === 'payrun')
    const payee = defs.find((d) => d.name === 'payee')
    expect(payrun?.default_member_permissions).toBe(String(Permission.ManageGuild))
    expect(payee?.default_member_permissions).toBeUndefined()
    for (const d of defs) expect(d.contexts).toEqual([0])
  })
})
