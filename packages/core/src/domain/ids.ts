import { z } from 'zod'
import type { Hex } from './hex.js'
import { isMemoSafeRunId } from './memo.js'

/** An EVM address, always stored and compared in lowercase. Never the zero address. */
export type Address = Hex
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte hex address')
  .transform((s) => s.toLowerCase() as Address)
  .refine((s) => !/^0x0{40}$/.test(s), 'the zero address cannot receive or hold funds')

/** A Discord snowflake (guild, user, role, channel), as a string. Guild ID = community ID. */
export const DiscordIdSchema = z.string().regex(/^\d{17,20}$/, 'expected a Discord snowflake')
export type DiscordId = z.infer<typeof DiscordIdSchema>

/** Run IDs go into the bytes32 memo, so they must fit the memo scheme. */
export const RunIdSchema = z.string().refine(isMemoSafeRunId, 'run IDs must be 1-24 printable ASCII chars')
export type RunId = z.infer<typeof RunIdSchema>

export const TxHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
