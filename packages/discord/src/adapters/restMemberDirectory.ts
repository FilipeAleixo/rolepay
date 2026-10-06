import type { DiscordRest, MemberDirectory } from '../ports.js'

/**
 * Role membership by looking up each candidate (a registered payee) with Get Guild
 * Member. Needs no privileged intent. Fine for the payees of one community (a run has
 * at most 50 lines); a large server could swap in a List Guild Members implementation,
 * which needs the GUILD_MEMBERS intent.
 */
export class RestMemberDirectory implements MemberDirectory {
  private readonly concurrency: number

  constructor(
    private readonly rest: Pick<DiscordRest, 'getMember'>,
    opts: { concurrency?: number } = {},
  ) {
    this.concurrency = opts.concurrency ?? 5
  }

  async withRole(input: { guildId: string; roleId: string; userIds: string[] }): Promise<string[]> {
    const everyone = input.roleId === input.guildId // @everyone's role ID is the guild ID
    const holds = new Array<boolean>(input.userIds.length).fill(false)
    let next = 0
    const worker = async () => {
      while (next < input.userIds.length) {
        const i = next++
        const member = await this.rest.getMember(input.guildId, input.userIds[i] as string)
        holds[i] = member !== null && (everyone || member.roles.includes(input.roleId))
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, input.userIds.length) }, worker))
    return input.userIds.filter((_, i) => holds[i])
  }
}
