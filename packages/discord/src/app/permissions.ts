import type { Community } from '@payrun/core'
import { Permission } from '../api.js'
import type { Caller } from './interaction.js'

/**
 * Who may do what. Discord's default_member_permissions only hides commands (and admins
 * can change it), so every rule is re-checked here from the signed interaction.
 */
export const canManageGuild = (c: Caller) => (c.permissions & (Permission.Administrator | Permission.ManageGuild)) !== 0n

/** The Treasurer: holds the community's approver role. No role set means nobody can approve. */
export const holdsApproverRole = (c: Caller, community: Community) => community.approverRoleId !== null && c.roles.includes(community.approverRoleId)

/** Creating runs, reading status and exporting: admins and treasurers. */
export const canOperate = (c: Caller, community: Community) => canManageGuild(c) || holdsApproverRole(c, community)

/**
 * Whether the caller may read a channel's history themselves: Discord computes their permissions
 * in a channel picked in an option. Without them (Discord always sends them) the answer is no.
 */
export const canReadHistory = (permissions: bigint | null | undefined) =>
  permissions != null &&
  ((permissions & Permission.Administrator) !== 0n || (permissions & (Permission.ViewChannel | Permission.ReadMessageHistory)) === (Permission.ViewChannel | Permission.ReadMessageHistory))
