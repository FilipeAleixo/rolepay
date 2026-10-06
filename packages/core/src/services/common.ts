import type { z } from 'zod'
import { err } from '../domain/result.js'

export type InvalidInput = { code: 'invalid_input'; issues: string[] }

/** Zod failure -> a plain, loggable result (never a raw ZodError). */
export function invalidInput(error: z.ZodError) {
  return err<InvalidInput>({
    code: 'invalid_input',
    issues: error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`),
  })
}
