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
