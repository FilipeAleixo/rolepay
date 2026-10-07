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
  const subcommandsOf = (d: Def[]) =>
    d
      .filter((c) => c.type === 1)
      .flatMap((c) =>
        (c.options ?? []).flatMap((o) =>
          o.type === OptionType.SubCommand ? [`${c.name} ${o.name}`] : o.type === OptionType.SubCommandGroup ? (o.options ?? []).map((s) => `${c.name} ${o.name} ${s.name}`) : [],
        ),
      )
  const subcommands = subcommandsOf(defs)

  it('every registered subcommand (dev shortcuts included) has a handler, and every handler is registered', () => {
    expect([...subcommandsOf(commandDefinitions({ devShortcuts: true }) as Def[])].sort()).toEqual([...ROUTED_COMMANDS].sort())
    expect(ROUTED_COMMANDS).toEqual(expect.arrayContaining(subcommands))
    // The only dev-only subcommand: making a policy's next run now ("time skips to Monday").
    expect(ROUTED_COMMANDS.filter((c) => !subcommands.includes(c))).toEqual(['rolepay policy run_now'])
  })

  it('/rolepay policy new|list|show|pause|resume|mode: the policy commands, hidden from members like the rest of /rolepay', () => {
    expect(subcommands.filter((c) => c.startsWith('rolepay policy '))).toEqual([
      'rolepay policy new',
      'rolepay policy list',
      'rolepay policy show',
      'rolepay policy pause',
      'rolepay policy resume',
      'rolepay policy mode',
    ])
    const policy = defs.find((d) => d.name === 'rolepay')?.options?.find((o) => o.name === 'policy')
    const opts = (sub: string) => policy?.options?.find((o) => o.name === sub)?.options?.map((o) => [o.name, o.type, o.required ?? false])
    expect(opts('new')).toEqual([
      ['instruction', OptionType.String, true],
      ['schedule', OptionType.String, true],
      ['hour', OptionType.Integer, true],
      ['weekday', OptionType.String, false],
      ['day', OptionType.Integer, false],
      ['timezone', OptionType.String, false],
      ['name', OptionType.String, false],
      ['max_per_run', OptionType.String, false],
      ['max_per_person', OptionType.String, false],
    ])
    expect(opts('mode')).toEqual([
      ['policy', OptionType.String, true],
      ['mode', OptionType.String, true],
      ['veto_hours', OptionType.Integer, false],
    ])
    const devMode = (commandDefinitions({ devShortcuts: true }) as Def[]).find((d) => d.name === 'rolepay')?.options?.find((o) => o.name === 'policy')?.options?.find((o) => o.name === 'mode')
    expect(devMode?.options?.map((o) => o.name)).toContain('veto_minutes')
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

  it('each command stays under the 4,000 characters Discord allows for names, descriptions and choices (dev shortcuts too)', () => {
    type Sized = { name: string; description?: string; options?: Sized[]; choices?: { name: string; value: string | number }[] }
    const size = (d: Sized): number =>
      d.name.length + (d.description?.length ?? 0) + (d.choices ?? []).reduce((n, c) => n + c.name.length + String(c.value).length, 0) + (d.options ?? []).reduce((n, o) => n + size(o), 0)
    for (const d of [...all, ...(commandDefinitions({ devShortcuts: true }) as Def[])] as Sized[]) expect([d.name, size(d) <= 4000]).toEqual([d.name, true])
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

  it('/rolepay propose takes an instruction, and optionally a channel or thread to read and how far back', () => {
    const propose = defs.find((d) => d.name === 'rolepay')?.options?.find((o) => o.name === 'propose')
    expect(propose?.options?.map((o) => [o.name, o.type, o.required ?? false])).toEqual([
      ['instruction', OptionType.String, true],
      ['source', OptionType.Channel, false],
      ['since', OptionType.String, false],
    ])
  })

  it('the dev shortcuts are registered only when they are on; by default they do not exist', () => {
    const setupOptions = (d: Def[]) =>
      (d.find((c) => c.name === 'rolepay')?.options?.find((o) => o.name === 'setup')?.options ?? []).map((o) => o.name)
    const dev = ['treasury', 'key_limit', 'new_key']
    for (const off of [COMMAND_DEFINITIONS, commandDefinitions({ devShortcuts: false })] as Def[][]) {
      expect(setupOptions(off)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(treasury|key_limit|new_key)$/)]))
      expect(setupOptions(off)).toContain('approver_role')
    }
    expect(setupOptions(commandDefinitions({ devShortcuts: true }) as Def[])).toEqual(expect.arrayContaining(dev))
  })

  it('/rolepay is shown to Manage Server by default; /payee to everyone; both only inside servers', () => {
    const rolepay = defs.find((d) => d.name === 'rolepay')
    const payee = defs.find((d) => d.name === 'payee')
    expect(rolepay?.default_member_permissions).toBe(String(Permission.ManageGuild))
    expect(payee?.default_member_permissions).toBeUndefined()
    for (const d of all) expect(d.contexts).toEqual([0])
  })
})
