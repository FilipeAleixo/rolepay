import { describe, expect, it } from 'vitest'
import { OptionType, Permission } from '../api.js'
import { ROUTED_COMMANDS, ROUTED_MESSAGE_COMMANDS } from '../app/router.js'
import { COMMAND_DEFINITIONS, commandDefinitions } from './definitions.js'

type Def = { name: string; description: string; type?: number; required?: boolean; options?: Def[]; default_member_permissions?: string; contexts?: number[] }
const all = COMMAND_DEFINITIONS as Def[]
/** Slash commands (type 1); message commands (type 3) have a display name and no description. */
const defs = all.filter((c) => c.type === 1)
const messageCommands = all.filter((c) => c.type === 3)

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
    for (const d of [...defs, ...(commandDefinitions({ devShortcuts: true }) as Def[]).filter((c) => c.type === 1)]) walk(d)
  })

  it('the message command "Propose pay run" is registered and routed, hidden from members by default, server only', () => {
    expect(messageCommands.map((c) => c.name)).toEqual([...ROUTED_MESSAGE_COMMANDS])
    for (const c of messageCommands) {
      expect(c.name.length).toBeLessThanOrEqual(32)
      expect(c).not.toHaveProperty('description')
      expect(c.default_member_permissions).toBe(String(Permission.ManageGuild))
      expect(c.contexts).toEqual([0])
    }
  })

  it('/payrun propose takes an instruction, and optionally a channel or thread to read and how far back', () => {
    const propose = defs.find((d) => d.name === 'payrun')?.options?.find((o) => o.name === 'propose')
    expect(propose?.options?.map((o) => [o.name, o.type, o.required ?? false])).toEqual([
      ['instruction', OptionType.String, true],
      ['source', OptionType.Channel, false],
      ['since', OptionType.String, false],
    ])
  })

  it('the dev shortcuts are registered only when they are on; by default they do not exist', () => {
    const setupOptions = (d: Def[]) =>
      (d.find((c) => c.name === 'payrun')?.options?.find((o) => o.name === 'setup')?.options ?? []).map((o) => o.name)
    const dev = ['treasury', 'key_limit', 'new_key']
    for (const off of [COMMAND_DEFINITIONS, commandDefinitions({ devShortcuts: false })] as Def[][]) {
      expect(setupOptions(off)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(treasury|key_limit|new_key)$/)]))
      expect(setupOptions(off)).toContain('approver_role')
    }
    expect(setupOptions(commandDefinitions({ devShortcuts: true }) as Def[])).toEqual(expect.arrayContaining(dev))
  })

  it('/payrun is shown to Manage Server by default; /payee to everyone; both only inside servers', () => {
    const payrun = defs.find((d) => d.name === 'payrun')
    const payee = defs.find((d) => d.name === 'payee')
    expect(payrun?.default_member_permissions).toBe(String(Permission.ManageGuild))
    expect(payee?.default_member_permissions).toBeUndefined()
    for (const d of all) expect(d.contexts).toEqual([0])
  })
})
