import { z } from 'zod'

/** Button actions on a run message. The custom_id is `payrun:<action>:<runId>` (Discord allows 100 chars). */
export const RUN_ACTIONS = ['approve', 'cancel', 'retry'] as const
export type RunAction = (typeof RUN_ACTIONS)[number]

const CustomIdSchema = z
  .string()
  .regex(/^payrun:[a-z]+:[\x21-\x7e]{1,24}$/)
  .transform((s) => s.split(':'))
  .pipe(z.tuple([z.literal('payrun'), z.enum(RUN_ACTIONS), z.string()]))

export const encodeCustomId = (action: RunAction, runId: string) => `payrun:${action}:${runId}`

export function decodeCustomId(customId: string): { action: RunAction; runId: string } | null {
  const parsed = CustomIdSchema.safeParse(customId)
  return parsed.success ? { action: parsed.data[1], runId: parsed.data[2] } : null
}

/** Buttons on a proposal: `proposal:<action>:<proposalId>`. */
export const PROPOSAL_ACTIONS = ['create', 'edit', 'discard'] as const
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number]

const ProposalIdSchema = z
  .string()
  .regex(/^proposal:[a-z]+:[A-Za-z0-9_]{1,40}$/)
  .transform((s) => s.split(':'))
  .pipe(z.tuple([z.literal('proposal'), z.enum(PROPOSAL_ACTIONS), z.string()]))

export const encodeProposalId = (action: ProposalAction, proposalId: string) => `proposal:${action}:${proposalId}`

export function decodeProposalId(customId: string): { action: ProposalAction; proposalId: string } | null {
  const parsed = ProposalIdSchema.safeParse(customId)
  return parsed.success ? { action: parsed.data[1], proposalId: parsed.data[2] } : null
}

/**
 * Modals: `proposal-modal:instruct:<messageId>` (the instruction for a message command's target)
 * and `proposal-modal:edit:<proposalId>` (the lines of a proposal).
 */
export const PROPOSAL_MODALS = ['instruct', 'edit'] as const
export type ProposalModal = (typeof PROPOSAL_MODALS)[number]

const ProposalModalIdSchema = z
  .string()
  .regex(/^proposal-modal:[a-z]+:[A-Za-z0-9_]{1,40}$/)
  .transform((s) => s.split(':'))
  .pipe(z.tuple([z.literal('proposal-modal'), z.enum(PROPOSAL_MODALS), z.string()]))

export const encodeProposalModalId = (modal: ProposalModal, id: string) => `proposal-modal:${modal}:${id}`

export function decodeProposalModalId(customId: string): { modal: ProposalModal; id: string } | null {
  const parsed = ProposalModalIdSchema.safeParse(customId)
  return parsed.success ? { modal: parsed.data[1], id: parsed.data[2] } : null
}
